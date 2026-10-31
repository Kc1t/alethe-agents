//! Voice provider keys in the OS keychain. On macOS a keychain read can show a password prompt
//! that blocks its thread until answered, so every read and write runs on a blocking thread, each
//! key is read at most once per run, and nothing reads a key until a voice actually needs it.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Serialize;
use tauri::AppHandle;

use super::CloudProvider;
use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const MAX_KEY_LEN: usize = 512;

fn active_profile_id(app: &AppHandle) -> Result<String, String> {
    Ok(crate::profiles::ensure_profiles_index(app)?.active_profile_id)
}

/// Trimmed key, or a fixed error code; the message never repeats the input.
pub(crate) fn validate_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty()
        || key.len() > MAX_KEY_LEN
        || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("voice_key_invalid_format".into());
    }
    Ok(key.to_string())
}

/// One key's cached answer: `None` until the keychain answered, then the key or `None` for no key.
type Slot = Arc<Mutex<Option<Option<String>>>>;

/// What the keychain answered for each (profile, secret), for the life of the process. Saving or
/// removing a key through the app updates it; a keychain error is never remembered, so the next
/// use asks again.
#[derive(Default)]
pub(crate) struct KeyCache(Mutex<HashMap<(String, SecretKind), Slot>>);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl KeyCache {
    /// The slot of one key. The map lock is held only to find it; the slot's own lock is held
    /// across the keychain call, so concurrent uses of that key wait for its one prompt while
    /// other keys stay readable.
    fn slot(&self, profile: &str, kind: SecretKind) -> Slot {
        lock(&self.0)
            .entry((profile.to_string(), kind))
            .or_default()
            .clone()
    }

    pub(crate) fn read_kind(
        &self,
        store: &impl SecretStore,
        profile: &str,
        kind: SecretKind,
    ) -> Result<Option<String>, String> {
        let slot = self.slot(profile, kind);
        let mut known = lock(&slot);
        if let Some(value) = known.as_ref() {
            return Ok(value.clone());
        }
        let value = store.get(profile, kind).map_err(|e| e.to_string())?;
        *known = Some(value.clone());
        Ok(value)
    }

    pub(crate) fn write_kind(
        &self,
        store: &impl SecretStore,
        profile: &str,
        kind: SecretKind,
        key: &str,
    ) -> Result<(), String> {
        let slot = self.slot(profile, kind);
        let mut known = lock(&slot);
        let result = store.set(profile, kind, key);
        *known = result.is_ok().then(|| Some(key.to_string()));
        result.map_err(|e| e.to_string())
    }

    pub(crate) fn delete_kind(
        &self,
        store: &impl SecretStore,
        profile: &str,
        kind: SecretKind,
    ) -> Result<(), String> {
        let slot = self.slot(profile, kind);
        let mut known = lock(&slot);
        let result = store.delete(profile, kind);
        *known = result.is_ok().then_some(None);
        result.map_err(|e| e.to_string())
    }

    pub(crate) fn read(
        &self,
        store: &impl SecretStore,
        profile: &str,
        provider: CloudProvider,
    ) -> Result<Option<String>, String> {
        self.read_kind(store, profile, SecretKind::VoiceProviderKey(provider))
    }

    pub(crate) fn write(
        &self,
        store: &impl SecretStore,
        profile: &str,
        provider: CloudProvider,
        key: &str,
    ) -> Result<(), String> {
        self.write_kind(store, profile, SecretKind::VoiceProviderKey(provider), key)
    }

    pub(crate) fn delete(
        &self,
        store: &impl SecretStore,
        profile: &str,
        provider: CloudProvider,
    ) -> Result<(), String> {
        self.delete_kind(store, profile, SecretKind::VoiceProviderKey(provider))
    }

    /// Removes every voice key of a profile. Each key is tried even when an earlier one fails; the
    /// first failure is reported.
    pub(crate) fn delete_profile(
        &self,
        store: &impl SecretStore,
        profile: &str,
    ) -> Result<(), String> {
        let mut first_error = None;
        for provider in CloudProvider::ALL {
            if let Err(error) = self.delete(store, profile, provider) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

static KEYS: LazyLock<KeyCache> = LazyLock::new(KeyCache::default);

/// Runs keychain work on tokio's blocking pool: a pending password prompt then holds a blocking
/// thread, never an async worker that unrelated commands need.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("voice key worker join: {e}"))?
}

/// The active profile's key for a provider. Blocks while the keychain asks for a password, so call
/// it only from a blocking thread; async code uses [`read_key_async`].
fn read_key(app: &AppHandle, provider: CloudProvider) -> Result<Option<String>, String> {
    KEYS.read(&OsSecretStore, &active_profile_id(app)?, provider)
}

/// The active profile's key for a provider, read on a blocking thread (once per run).
pub(crate) async fn read_key_async(
    app: &AppHandle,
    provider: CloudProvider,
) -> Result<Option<String>, String> {
    let app = app.clone();
    blocking(move || read_key(&app, provider)).await
}

/// Removes every voice key of a profile (profile deletion).
pub(crate) fn delete_profile_keys(profile: &str) -> Result<(), String> {
    KEYS.delete_profile(&OsSecretStore, profile)
}

/// A secret of the active profile other than a provider key (a local voice server's key), read on
/// a blocking thread once per run.
pub(crate) async fn read_secret_async(
    app: &AppHandle,
    kind: SecretKind,
) -> Result<Option<String>, String> {
    let app = app.clone();
    blocking(move || KEYS.read_kind(&OsSecretStore, &active_profile_id(&app)?, kind)).await
}

pub(crate) async fn write_secret_async(
    app: &AppHandle,
    kind: SecretKind,
    value: String,
) -> Result<(), String> {
    let app = app.clone();
    blocking(move || KEYS.write_kind(&OsSecretStore, &active_profile_id(&app)?, kind, &value))
        .await
}

pub(crate) async fn delete_secret_async(app: &AppHandle, kind: SecretKind) -> Result<(), String> {
    let app = app.clone();
    blocking(move || KEYS.delete_kind(&OsSecretStore, &active_profile_id(&app)?, kind)).await
}

/// Removes one secret of `profile` (profile deletion, already on a blocking path).
pub(crate) fn delete_secret(profile: &str, kind: SecretKind) -> Result<(), String> {
    KEYS.delete_kind(&OsSecretStore, profile, kind)
}

#[tauri::command]
pub async fn voice_provider_set_key(
    app: AppHandle,
    provider: CloudProvider,
    key: String,
) -> Result<(), String> {
    let key = validate_key(&key)?;
    blocking(move || KEYS.write(&OsSecretStore, &active_profile_id(&app)?, provider, &key)).await
}

#[tauri::command]
pub async fn voice_provider_delete_key(
    app: AppHandle,
    provider: CloudProvider,
) -> Result<(), String> {
    blocking(move || KEYS.delete(&OsSecretStore, &active_profile_id(&app)?, provider)).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTestResult {
    pub ok: bool,
    pub reason: Option<super::http::CloudErrorKind>,
    /// Why a key the provider accepted still cannot be used: `provisioningKey` for an OpenRouter
    /// provisioning key, which manages keys but cannot call models.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<&'static str>,
}

#[tauri::command]
pub async fn voice_provider_test(
    app: AppHandle,
    provider: CloudProvider,
) -> Result<VoiceTestResult, String> {
    use super::http::{send, test_request, CloudErrorKind};
    let Some(key) = read_key_async(&app, provider).await? else {
        return Ok(VoiceTestResult {
            ok: false,
            reason: Some(CloudErrorKind::Auth),
            hint: None,
        });
    };
    Ok(
        match send(
            test_request(provider, &key),
            std::time::Duration::from_secs(15),
        )
        .await
        {
            // `/api/v1/key` answers for a provisioning key too, but speech then fails with 401.
            Ok(body)
                if provider == CloudProvider::Openrouter
                    && super::openrouter::is_provisioning_key(&body) =>
            {
                VoiceTestResult {
                    ok: false,
                    reason: Some(CloudErrorKind::Auth),
                    hint: Some("provisioningKey"),
                }
            }
            Ok(_) => VoiceTestResult {
                ok: true,
                reason: None,
                hint: None,
            },
            Err(error) => VoiceTestResult {
                ok: false,
                reason: Some(error.kind),
                hint: None,
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::SecureStoreError;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<(String, SecretKind), String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, profile: &str, kind: SecretKind) -> Result<Option<String>, SecureStoreError> {
            Ok(self.0.borrow().get(&(profile.to_string(), kind)).cloned())
        }
        fn set(
            &self,
            profile: &str,
            kind: SecretKind,
            value: &str,
        ) -> Result<(), SecureStoreError> {
            self.0
                .borrow_mut()
                .insert((profile.to_string(), kind), value.to_string());
            Ok(())
        }
        fn delete(&self, profile: &str, kind: SecretKind) -> Result<(), SecureStoreError> {
            self.0.borrow_mut().remove(&(profile.to_string(), kind));
            Ok(())
        }
    }

    #[test]
    fn keys_are_trimmed_and_rejected_when_malformed() {
        assert_eq!(validate_key("  sk-abc  ").unwrap(), "sk-abc");
        assert!(validate_key("   ").is_err());
        assert!(validate_key("sk abc").is_err());
        assert!(validate_key(&"x".repeat(513)).is_err());
    }

    #[test]
    fn deleting_a_profile_removes_all_its_voice_keys_only() {
        let store = MemoryStore::default();
        for provider in CloudProvider::ALL {
            store
                .set("a", SecretKind::VoiceProviderKey(provider), "k")
                .unwrap();
        }
        store
            .set(
                "b",
                SecretKind::VoiceProviderKey(CloudProvider::Openai),
                "k",
            )
            .unwrap();
        KeyCache::default().delete_profile(&store, "a").unwrap();
        let has = |profile: &str, provider| {
            store
                .get(profile, SecretKind::VoiceProviderKey(provider))
                .unwrap()
                .is_some()
        };
        assert!(CloudProvider::ALL.iter().all(|p| !has("a", *p)));
        assert!(has("b", CloudProvider::Openai));
    }

    /// Counts reads and can fail them, to see what reaches the keychain.
    #[derive(Default)]
    struct CountingStore {
        inner: MemoryStore,
        gets: std::cell::Cell<usize>,
        fail: std::cell::Cell<bool>,
    }

    impl SecretStore for CountingStore {
        fn get(&self, profile: &str, kind: SecretKind) -> Result<Option<String>, SecureStoreError> {
            self.gets.set(self.gets.get() + 1);
            if self.fail.get() {
                return Err(SecureStoreError::Unavailable("read"));
            }
            self.inner.get(profile, kind)
        }
        fn set(
            &self,
            profile: &str,
            kind: SecretKind,
            value: &str,
        ) -> Result<(), SecureStoreError> {
            self.inner.set(profile, kind, value)
        }
        fn delete(&self, profile: &str, kind: SecretKind) -> Result<(), SecureStoreError> {
            self.inner.delete(profile, kind)
        }
    }

    #[test]
    fn a_key_is_read_from_the_keychain_once_per_run() {
        let store = CountingStore::default();
        store
            .inner
            .set(
                "a",
                SecretKind::VoiceProviderKey(CloudProvider::Openai),
                "k",
            )
            .unwrap();
        let cache = KeyCache::default();
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Openai).unwrap(),
            Some("k".into())
        );
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Openai).unwrap(),
            Some("k".into())
        );
        assert_eq!(store.gets.get(), 1);
        // A missing key is remembered too.
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Gemini).unwrap(),
            None
        );
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Gemini).unwrap(),
            None
        );
        assert_eq!(store.gets.get(), 2);
        // Each profile has its own entry.
        assert_eq!(
            cache.read(&store, "b", CloudProvider::Openai).unwrap(),
            None
        );
        assert_eq!(store.gets.get(), 3);
    }

    #[test]
    fn a_keychain_error_is_not_remembered() {
        let store = CountingStore::default();
        store
            .inner
            .set(
                "a",
                SecretKind::VoiceProviderKey(CloudProvider::Openai),
                "k",
            )
            .unwrap();
        let cache = KeyCache::default();
        store.fail.set(true);
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Openai).unwrap_err(),
            "secure_store_unavailable: read"
        );
        store.fail.set(false);
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Openai).unwrap(),
            Some("k".into())
        );
        assert_eq!(store.gets.get(), 2);
    }

    #[test]
    fn saving_and_removing_a_key_update_the_cache() {
        let store = CountingStore::default();
        let cache = KeyCache::default();
        cache
            .write(&store, "a", CloudProvider::Openai, "k1")
            .unwrap();
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Openai).unwrap(),
            Some("k1".into())
        );
        cache.delete(&store, "a", CloudProvider::Openai).unwrap();
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Openai).unwrap(),
            None
        );
        assert_eq!(store.gets.get(), 0, "both answers come from the cache");
        assert!(store
            .inner
            .get("a", SecretKind::VoiceProviderKey(CloudProvider::Openai))
            .unwrap()
            .is_none());
    }

    #[test]
    fn deleting_a_profile_clears_its_cached_keys_only() {
        let store = CountingStore::default();
        let cache = KeyCache::default();
        cache
            .write(&store, "a", CloudProvider::Gemini, "k")
            .unwrap();
        cache
            .write(&store, "b", CloudProvider::Gemini, "k")
            .unwrap();
        cache.delete_profile(&store, "a").unwrap();
        assert_eq!(
            cache.read(&store, "a", CloudProvider::Gemini).unwrap(),
            None
        );
        assert_eq!(
            cache.read(&store, "b", CloudProvider::Gemini).unwrap(),
            Some("k".into())
        );
        assert_eq!(store.gets.get(), 0);
    }

    /// A store whose OpenAI read waits until the test releases it, like an open password prompt.
    struct PromptingStore {
        started: Mutex<std::sync::mpsc::Sender<()>>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl SecretStore for PromptingStore {
        fn get(
            &self,
            _profile: &str,
            kind: SecretKind,
        ) -> Result<Option<String>, SecureStoreError> {
            if kind == SecretKind::VoiceProviderKey(CloudProvider::Openai) {
                self.started.lock().unwrap().send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                return Ok(Some("slow".into()));
            }
            Ok(None)
        }
        fn set(&self, _: &str, _: SecretKind, _: &str) -> Result<(), SecureStoreError> {
            Ok(())
        }
        fn delete(&self, _: &str, _: SecretKind) -> Result<(), SecureStoreError> {
            Ok(())
        }
    }

    #[test]
    fn a_pending_read_does_not_block_other_providers() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let (started_tx, started_rx) = channel();
        let (release_tx, release_rx) = channel();
        let store = PromptingStore {
            started: Mutex::new(started_tx),
            release: Mutex::new(release_rx),
        };
        let cache = KeyCache::default();
        cache
            .write(&store, "a", CloudProvider::Gemini, "k")
            .unwrap();
        std::thread::scope(|scope| {
            let slow = scope.spawn(|| cache.read(&store, "a", CloudProvider::Openai));
            started_rx.recv().unwrap();
            let (done_tx, done_rx) = channel();
            let (cache, store) = (&cache, &store);
            scope.spawn(move || {
                done_tx
                    .send(cache.read(store, "a", CloudProvider::Gemini))
                    .unwrap()
            });
            let other = done_rx.recv_timeout(Duration::from_secs(2));
            // Release the pending read before asserting, so a failure cannot hang the scope.
            release_tx.send(()).unwrap();
            assert_eq!(
                other.expect("blocked by the pending read"),
                Ok(Some("k".into()))
            );
            assert_eq!(slow.join().unwrap(), Ok(Some("slow".into())));
        });
    }

    #[test]
    fn concurrent_reads_of_a_key_share_one_keychain_read() {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let store = PromptingStore {
            started: Mutex::new(started_tx),
            release: Mutex::new(release_rx),
        };
        let cache = KeyCache::default();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| cache.read(&store, "a", CloudProvider::Openai));
            started_rx.recv().unwrap();
            let second = scope.spawn(|| cache.read(&store, "a", CloudProvider::Openai));
            std::thread::sleep(std::time::Duration::from_millis(50));
            // Two releases, so a second keychain read would finish (and be counted) instead of hang.
            release_tx.send(()).unwrap();
            release_tx.send(()).unwrap();
            assert_eq!(first.join().unwrap(), Ok(Some("slow".into())));
            assert_eq!(second.join().unwrap(), Ok(Some("slow".into())));
        });
        // A second keychain read would have announced itself here.
        assert!(started_rx.try_recv().is_err());
    }

    #[test]
    fn keychain_work_runs_on_a_blocking_thread() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let caller = std::thread::current().id();
        let worker = runtime
            .block_on(blocking(|| Ok(std::thread::current().id())))
            .unwrap();
        assert_ne!(worker, caller);
    }

    #[test]
    fn server_keys_share_the_cache_and_stay_apart_from_provider_keys() {
        let store = MemoryStore::default();
        let cache = KeyCache::default();
        let id = crate::voice_servers::id::ServerId::parse("V1StGXR8_Z5jdHi6B-myT").unwrap();
        let kind = SecretKind::VoiceServerKey(id);
        cache.write_kind(&store, "p", kind, "server-key").unwrap();
        cache.write(&store, "p", CloudProvider::Openai, "openai-key").unwrap();
        assert_eq!(cache.read_kind(&store, "p", kind).unwrap().as_deref(), Some("server-key"));
        assert_eq!(cache.read(&store, "p", CloudProvider::Openai).unwrap().as_deref(), Some("openai-key"));
        cache.delete_kind(&store, "p", kind).unwrap();
        assert_eq!(cache.read_kind(&store, "p", kind).unwrap(), None);
    }

    #[test]
    fn errors_never_echo_the_key() {
        let error = validate_key("bad key with spaces").unwrap_err();
        assert!(!error.contains("bad key"));
    }
}

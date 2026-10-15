use serde::Serialize;
use tauri::AppHandle;

use super::CloudProvider;
use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const MAX_KEY_LEN: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: CloudProvider,
    pub configured: bool,
}

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

pub(crate) fn statuses(
    store: &impl SecretStore,
    profile: &str,
) -> Result<Vec<ProviderStatus>, String> {
    CloudProvider::ALL
        .iter()
        .map(|provider| {
            let configured = store
                .get(profile, SecretKind::VoiceProviderKey(*provider))
                .map_err(|e| e.to_string())?
                .is_some();
            Ok(ProviderStatus {
                provider: *provider,
                configured,
            })
        })
        .collect()
}

pub(crate) fn read_key(app: &AppHandle, provider: CloudProvider) -> Result<Option<String>, String> {
    let profile = active_profile_id(app)?;
    OsSecretStore
        .get(&profile, SecretKind::VoiceProviderKey(provider))
        .map_err(|e| e.to_string())
}

/// Removes every voice key of a profile. Each key is tried even when an earlier one fails; the
/// first failure is reported.
pub(crate) fn delete_profile_keys_in(
    store: &impl SecretStore,
    profile: &str,
) -> Result<(), String> {
    let mut first_error = None;
    for provider in CloudProvider::ALL {
        if let Err(error) = store.delete(profile, SecretKind::VoiceProviderKey(provider)) {
            first_error.get_or_insert(error.to_string());
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(crate) fn delete_profile_keys(profile: &str) -> Result<(), String> {
    delete_profile_keys_in(&OsSecretStore, profile)
}

#[tauri::command]
pub async fn voice_provider_set_key(
    app: AppHandle,
    provider: CloudProvider,
    key: String,
) -> Result<(), String> {
    let key = validate_key(&key)?;
    let profile = active_profile_id(&app)?;
    OsSecretStore
        .set(&profile, SecretKind::VoiceProviderKey(provider), &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_provider_delete_key(
    app: AppHandle,
    provider: CloudProvider,
) -> Result<(), String> {
    let profile = active_profile_id(&app)?;
    OsSecretStore
        .delete(&profile, SecretKind::VoiceProviderKey(provider))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_providers_status(app: AppHandle) -> Result<Vec<ProviderStatus>, String> {
    statuses(&OsSecretStore, &active_profile_id(&app)?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTestResult {
    pub ok: bool,
    pub reason: Option<super::http::CloudErrorKind>,
}

#[tauri::command]
pub async fn voice_provider_test(
    app: AppHandle,
    provider: CloudProvider,
) -> Result<VoiceTestResult, String> {
    use super::http::{send, test_request, CloudErrorKind};
    let Some(key) = read_key(&app, provider)? else {
        return Ok(VoiceTestResult {
            ok: false,
            reason: Some(CloudErrorKind::Auth),
        });
    };
    Ok(
        match send(
            test_request(provider, &key),
            std::time::Duration::from_secs(15),
        )
        .await
        {
            Ok(_) => VoiceTestResult {
                ok: true,
                reason: None,
            },
            Err(error) => VoiceTestResult {
                ok: false,
                reason: Some(error.kind),
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
    fn status_reports_only_the_profile_own_keys() {
        let store = MemoryStore::default();
        store
            .set(
                "a",
                SecretKind::VoiceProviderKey(CloudProvider::Gemini),
                "k",
            )
            .unwrap();
        let a = statuses(&store, "a").unwrap();
        let b = statuses(&store, "b").unwrap();
        assert!(a
            .iter()
            .any(|s| s.provider == CloudProvider::Gemini && s.configured));
        assert!(b.iter().all(|s| !s.configured));
        assert_eq!(a.len(), 4);
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
        delete_profile_keys_in(&store, "a").unwrap();
        assert!(statuses(&store, "a").unwrap().iter().all(|s| !s.configured));
        assert!(statuses(&store, "b")
            .unwrap()
            .iter()
            .any(|s| s.provider == CloudProvider::Openai && s.configured));
    }

    #[test]
    fn errors_never_echo_the_key() {
        let error = validate_key("bad key with spaces").unwrap_err();
        assert!(!error.contains("bad key"));
    }
}

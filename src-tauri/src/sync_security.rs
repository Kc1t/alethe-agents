use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const SECURITY_SCHEMA_VERSION: u32 = 1;
const DEVICE_KEY_SERVICE: &str = "com.kc1t.alethe.sync-device";
const MAX_AUDIT_EVENTS: usize = 2_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedAccount {
    pub account_id: String,
    pub provider: String,
    pub display_name: String,
    pub email_hint: Option<String>,
    pub connected_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceTrust {
    Pending,
    Trusted,
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub device_id: String,
    pub account_id: String,
    pub display_name: String,
    pub public_key: String,
    pub public_key_fingerprint: String,
    pub trust: DeviceTrust,
    pub registered_at_ms: u64,
    pub last_verified_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityAuditEvent {
    pub sequence: u64,
    pub occurred_at_ms: u64,
    pub kind: String,
    pub actor_device_id: Option<String>,
    pub target_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSecurityDocument {
    pub schema_version: u32,
    pub account: Option<VerifiedAccount>,
    pub devices: Vec<DeviceRecord>,
    pub audit: Vec<SecurityAuditEvent>,
}

impl Default for SyncSecurityDocument {
    fn default() -> Self {
        Self {
            schema_version: SECURITY_SCHEMA_VERSION,
            account: None,
            devices: Vec::new(),
            audit: Vec::new(),
        }
    }
}

pub trait DeviceSecretStore {
    fn set(&self, device_id: &str, secret: &[u8]) -> Result<(), String>;
    fn delete(&self, device_id: &str) -> Result<(), String>;
}

pub struct PlatformDeviceSecretStore;

impl DeviceSecretStore for PlatformDeviceSecretStore {
    fn set(&self, device_id: &str, secret: &[u8]) -> Result<(), String> {
        let entry = keyring::Entry::new(DEVICE_KEY_SERVICE, device_id)
            .map_err(|_| "credential_store_unavailable".to_string())?;
        entry
            .set_secret(secret)
            .map_err(|_| "credential_store_write_failed".to_string())
    }

    fn delete(&self, device_id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(DEVICE_KEY_SERVICE, device_id)
            .map_err(|_| "credential_store_unavailable".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("credential_store_delete_failed".to_string()),
        }
    }
}

pub fn security_document_path(data_root: &Path) -> PathBuf {
    data_root.join("sync").join("security-v1.json")
}

pub fn load_at(data_root: &Path) -> Result<SyncSecurityDocument, String> {
    let path = security_document_path(data_root);
    if !path.exists() {
        return Ok(SyncSecurityDocument::default());
    }
    let bytes = fs::read(&path).map_err(|_| "security_document_read_failed".to_string())?;
    let document: SyncSecurityDocument =
        serde_json::from_slice(&bytes).map_err(|_| "security_document_invalid".to_string())?;
    validate_document(&document)?;
    Ok(document)
}

fn validate_document(document: &SyncSecurityDocument) -> Result<(), String> {
    if document.schema_version != SECURITY_SCHEMA_VERSION {
        return Err("security_schema_unsupported".to_string());
    }
    if let Some(account) = &document.account {
        if account.account_id.trim().is_empty() || account.display_name.trim().is_empty() {
            return Err("security_account_invalid".to_string());
        }
    }
    for device in &document.devices {
        if device.device_id.trim().is_empty()
            || device.public_key.trim().is_empty()
            || document
                .account
                .as_ref()
                .is_none_or(|account| account.account_id != device.account_id)
        {
            return Err("security_device_invalid".to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err("security_document_commit_failed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|_| "security_document_commit_failed".to_string())
}

fn save_at(data_root: &Path, document: &SyncSecurityDocument) -> Result<(), String> {
    validate_document(document)?;
    let path = security_document_path(data_root);
    let parent = path
        .parent()
        .ok_or_else(|| "security_document_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "security_document_directory_failed".to_string())?;
    let temporary = parent.join(format!(".security-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|_| "security_document_serialize_failed".to_string())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "security_document_write_failed".to_string())?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("security_document_write_failed".to_string());
    }
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })?;
    if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn append_audit(
    document: &mut SyncSecurityDocument,
    occurred_at_ms: u64,
    kind: &str,
    actor_device_id: Option<String>,
    target_id: Option<String>,
) {
    let sequence = document.audit.last().map_or(1, |event| event.sequence + 1);
    document.audit.push(SecurityAuditEvent {
        sequence,
        occurred_at_ms,
        kind: kind.to_string(),
        actor_device_id,
        target_id,
    });
    if document.audit.len() > MAX_AUDIT_EVENTS {
        document
            .audit
            .drain(0..document.audit.len() - MAX_AUDIT_EVENTS);
    }
}

fn public_key_fingerprint(key: &VerifyingKey) -> String {
    let digest = Sha256::digest(key.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Completes identity only after the OAuth backend has verified the provider response.
/// This function is intentionally not exposed as a Tauri or HTTP command.
pub(crate) fn complete_verified_identity<S: DeviceSecretStore>(
    data_root: &Path,
    secret_store: &S,
    account: VerifiedAccount,
    device_name: &str,
    now_ms: u64,
) -> Result<DeviceRecord, String> {
    if account.account_id.trim().is_empty() || device_name.trim().is_empty() {
        return Err("verified_identity_invalid".to_string());
    }
    let mut document = load_at(data_root)?;
    if document
        .account
        .as_ref()
        .is_some_and(|current| current.account_id != account.account_id)
        && !document.devices.is_empty()
    {
        return Err("account_switch_requires_disconnect".to_string());
    }

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let device_id = format!("dev_{}", nanoid::nanoid!(24));
    secret_store.set(&device_id, &signing_key.to_bytes())?;
    let device = DeviceRecord {
        device_id: device_id.clone(),
        account_id: account.account_id.clone(),
        display_name: device_name.trim().to_string(),
        public_key: URL_SAFE_NO_PAD.encode(verifying_key.as_bytes()),
        public_key_fingerprint: public_key_fingerprint(&verifying_key),
        trust: DeviceTrust::Pending,
        registered_at_ms: now_ms,
        last_verified_at_ms: None,
        revoked_at_ms: None,
    };
    document.account = Some(account);
    document.devices.push(device.clone());
    append_audit(
        &mut document,
        now_ms,
        "device.registered",
        Some(device_id),
        None,
    );
    if let Err(error) = save_at(data_root, &document) {
        let _ = secret_store.delete(&device.device_id);
        return Err(error);
    }
    Ok(device)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, Vec<u8>>>);

    impl DeviceSecretStore for MemorySecrets {
        fn set(&self, device_id: &str, secret: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(device_id.to_string(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, device_id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(device_id);
            Ok(())
        }
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("alethe-sync-security-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn account(id: &str) -> VerifiedAccount {
        VerifiedAccount {
            account_id: id.to_string(),
            provider: "google".to_string(),
            display_name: "Test User".to_string(),
            email_hint: Some("t***@example.test".to_string()),
            connected_at_ms: 1_000,
        }
    }

    #[test]
    fn stores_private_key_only_in_credential_store() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let device =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Linux PC", 2_000)
                .unwrap();
        complete_verified_identity(&root, &secrets, account("acct-a"), "Windows PC", 3_000)
            .unwrap();

        let persisted = fs::read_to_string(security_document_path(&root)).unwrap();
        let secret = secrets
            .0
            .lock()
            .unwrap()
            .get(&device.device_id)
            .unwrap()
            .clone();
        assert_eq!(secret.len(), 32);
        assert!(!persisted.contains(&URL_SAFE_NO_PAD.encode(secret)));
        assert!(persisted.contains(&device.public_key_fingerprint));
        let loaded = load_at(&root).unwrap();
        assert_eq!(loaded.devices.len(), 2);
        assert_eq!(loaded.audit[0].kind, "device.registered");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_corrupt_documents_and_implicit_account_switches() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        complete_verified_identity(&root, &secrets, account("acct-a"), "PC", 2_000).unwrap();
        assert_eq!(
            complete_verified_identity(&root, &secrets, account("acct-b"), "PC", 3_000),
            Err("account_switch_requires_disconnect".to_string())
        );

        fs::write(security_document_path(&root), b"{broken").unwrap();
        assert_eq!(load_at(&root), Err("security_document_invalid".to_string()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_devices_not_bound_to_the_verified_account() {
        let document = SyncSecurityDocument {
            schema_version: SECURITY_SCHEMA_VERSION,
            account: Some(account("acct-a")),
            devices: vec![DeviceRecord {
                device_id: "device-a".to_string(),
                account_id: "acct-b".to_string(),
                display_name: "PC".to_string(),
                public_key: "public".to_string(),
                public_key_fingerprint: "fingerprint".to_string(),
                trust: DeviceTrust::Pending,
                registered_at_ms: 1,
                last_verified_at_ms: None,
                revoked_at_ms: None,
            }],
            audit: vec![],
        };
        assert_eq!(
            validate_document(&document),
            Err("security_device_invalid".to_string())
        );
    }
}

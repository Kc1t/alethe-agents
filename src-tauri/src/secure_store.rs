use std::fmt;

const SERVICE: &str = "com.kc1t.alethe";

#[derive(Clone, Copy)]
pub enum SecretKind {
    GithubSyncToken,
}

impl SecretKind {
    fn suffix(self) -> &'static str {
        match self {
            Self::GithubSyncToken => "github-sync-token",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecureStoreError {
    Unavailable(String),
}

impl fmt::Display for SecureStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(message) => write!(formatter, "secure_store_unavailable: {message}"),
        }
    }
}

pub trait SecretStore {
    fn get(&self, profile_id: &str, kind: SecretKind) -> Result<Option<String>, SecureStoreError>;
    fn set(&self, profile_id: &str, kind: SecretKind, value: &str) -> Result<(), SecureStoreError>;
    fn delete(&self, profile_id: &str, kind: SecretKind) -> Result<(), SecureStoreError>;
}

pub struct OsSecretStore;

fn account(profile_id: &str, kind: SecretKind) -> String {
    format!("profile:{profile_id}:{}", kind.suffix())
}

fn entry(profile_id: &str, kind: SecretKind) -> Result<keyring::Entry, SecureStoreError> {
    keyring::Entry::new(SERVICE, &account(profile_id, kind))
        .map_err(|error| SecureStoreError::Unavailable(error.to_string()))
}

impl SecretStore for OsSecretStore {
    fn get(&self, profile_id: &str, kind: SecretKind) -> Result<Option<String>, SecureStoreError> {
        match entry(profile_id, kind)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(SecureStoreError::Unavailable(error.to_string())),
        }
    }

    fn set(&self, profile_id: &str, kind: SecretKind, value: &str) -> Result<(), SecureStoreError> {
        entry(profile_id, kind)?
            .set_password(value)
            .map_err(|error| SecureStoreError::Unavailable(error.to_string()))
    }

    fn delete(&self, profile_id: &str, kind: SecretKind) -> Result<(), SecureStoreError> {
        match entry(profile_id, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(SecureStoreError::Unavailable(error.to_string())),
        }
    }
}

pub fn delete_github_sync_token(profile_id: &str) -> Result<(), String> {
    OsSecretStore
        .delete(profile_id, SecretKind::GithubSyncToken)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_accounts_are_stable_and_isolated() {
        assert_eq!(
            account("default", SecretKind::GithubSyncToken),
            "profile:default:github-sync-token"
        );
        assert_ne!(
            account("profile-a", SecretKind::GithubSyncToken),
            account("profile-b", SecretKind::GithubSyncToken)
        );
    }
}

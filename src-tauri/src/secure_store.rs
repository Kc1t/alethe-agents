use std::fmt;

const SERVICE: &str = "com.kc1t.alethe";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SecretKind {
    SpotifyClientSecret,
    SpotifyAccessToken,
    SpotifyRefreshToken,
}

impl SecretKind {
    fn suffix(self) -> &'static str {
        match self {
            Self::SpotifyClientSecret => "spotify-client-secret",
            Self::SpotifyAccessToken => "spotify-access-token",
            Self::SpotifyRefreshToken => "spotify-refresh-token",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecureStoreError {
    Unavailable(&'static str),
}

impl fmt::Display for SecureStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(operation) => {
                write!(formatter, "secure_store_unavailable: {operation}")
            }
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
        .map_err(|_| SecureStoreError::Unavailable("create_entry"))
}

impl SecretStore for OsSecretStore {
    fn get(&self, profile_id: &str, kind: SecretKind) -> Result<Option<String>, SecureStoreError> {
        match entry(profile_id, kind)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(SecureStoreError::Unavailable("read")),
        }
    }

    fn set(&self, profile_id: &str, kind: SecretKind, value: &str) -> Result<(), SecureStoreError> {
        entry(profile_id, kind)?
            .set_password(value)
            .map_err(|_| SecureStoreError::Unavailable("write"))
    }

    fn delete(&self, profile_id: &str, kind: SecretKind) -> Result<(), SecureStoreError> {
        match entry(profile_id, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecureStoreError::Unavailable("delete")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotify_accounts_are_stable_and_profile_scoped() {
        assert_eq!(
            account("default", SecretKind::SpotifyClientSecret),
            "profile:default:spotify-client-secret"
        );
        assert_eq!(
            account("default", SecretKind::SpotifyAccessToken),
            "profile:default:spotify-access-token"
        );
        assert_ne!(
            account("profile-a", SecretKind::SpotifyRefreshToken),
            account("profile-b", SecretKind::SpotifyRefreshToken)
        );
    }

    #[test]
    fn errors_do_not_include_backend_or_secret_details() {
        let secret = "super-secret-value";
        let error = SecureStoreError::Unavailable("write").to_string();
        assert_eq!(error, "secure_store_unavailable: write");
        assert!(!error.contains(secret));
    }
}

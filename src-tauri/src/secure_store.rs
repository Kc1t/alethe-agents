use std::fmt;

const SERVICE: &str = "com.kc1t.alethe";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SecretKind {
    GithubSyncToken,
    SpotifyClientSecret,
    SpotifyAccessToken,
    SpotifyRefreshToken,
    VoiceProviderKey(crate::voice_providers::CloudProvider),
}

impl SecretKind {
    fn suffix(self) -> &'static str {
        match self {
            Self::GithubSyncToken => "github-sync-token",
            Self::SpotifyClientSecret => "spotify-client-secret",
            Self::SpotifyAccessToken => "spotify-access-token",
            Self::SpotifyRefreshToken => "spotify-refresh-token",
            Self::VoiceProviderKey(provider) => match provider {
                crate::voice_providers::CloudProvider::Openai => "voice-key-openai",
                crate::voice_providers::CloudProvider::Elevenlabs => "voice-key-elevenlabs",
                crate::voice_providers::CloudProvider::Gemini => "voice-key-gemini",
                crate::voice_providers::CloudProvider::Openrouter => "voice-key-openrouter",
            },
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

pub fn delete_github_sync_token(profile_id: &str) -> Result<(), String> {
    OsSecretStore
        .delete(profile_id, SecretKind::GithubSyncToken)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotify_accounts_are_stable_and_profile_scoped() {
        assert_eq!(
            account("default", SecretKind::GithubSyncToken),
            "profile:default:github-sync-token"
        );
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

    #[test]
    fn voice_provider_keys_have_distinct_stable_accounts() {
        use crate::voice_providers::CloudProvider;
        let accounts: Vec<String> = CloudProvider::ALL
            .iter()
            .map(|provider| account("p", SecretKind::VoiceProviderKey(*provider)))
            .collect();
        assert_eq!(accounts[0], "profile:p:voice-key-openai");
        assert_eq!(accounts[3], "profile:p:voice-key-openrouter");
        let unique: std::collections::HashSet<_> = accounts.iter().collect();
        assert_eq!(unique.len(), 4);
    }
}

//! Redundant P2P candidate signaling over a GitHub Gist — an *additional*, opt-in channel
//! alongside the Cloudflare rendezvous relay (`sync_rendezvous.rs`), which stays the primary path.
//! This module never carries project/file data, only the same small, already-X25519-encrypted
//! candidate envelope `sync_p2p_bridge::sync_prepare_remote_candidate` produces for the Cloudflare
//! path — it is purely an alternate transport for that same ciphertext, so the rest of the P2P
//! flow (hole punching, `useP2pAutoConnect.ts`) never needs to know which signaling channel a
//! candidate arrived through.
//!
//! Bootstrap: each peer publishes to *their own* Gist (their own GitHub account, their own token —
//! never a shared Alethe-owned account), and the Gist id is exchanged as part of the pairing
//! invitation envelope (`sync_invitation_bridge.rs`) alongside the device's public keys, not
//! discovered live over this channel — this module only reads/writes a Gist whose id it is already
//! told, it never searches for one.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const GITHUB_SIGNALING_SERVICE: &str = "com.kc1t.alethe.github-signaling";
const GITHUB_SIGNALING_TOKEN_ENTRY: &str = "token";
const GITHUB_API: &str = "https://api.github.com";
const USER_AGENT: &str = "Alethe";
const GIST_DESCRIPTION: &str = "Alethe P2P signaling (managed by the app — safe to delete, entries expire on their own)";

/// Same TTL the Cloudflare candidate envelope already uses (`sync_rendezvous.rs`'s
/// `MAX_CANDIDATE_TTL_MS`) — a candidate describes a currently-bound UDP socket, so anything older
/// than this is stale by construction, on either transport.
const CANDIDATE_TTL_MS: u64 = 5 * 60 * 1_000;
/// Ceiling on entries retained per Gist file — bounds the payload size regardless of how many
/// stale/abandoned sessions a peer's device has accumulated entries for.
const MAX_ENTRIES_PER_SESSION_FILE: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GithubSignalingError {
    NoToken,
    InvalidToken,
    RequestFailed,
    RateLimited,
    NotFound,
    Encode,
    Decode,
    CredentialStoreUnavailable,
}

impl std::fmt::Display for GithubSignalingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            GithubSignalingError::NoToken => "github_signaling_no_token",
            GithubSignalingError::InvalidToken => "github_signaling_invalid_token",
            GithubSignalingError::RequestFailed => "github_signaling_request_failed",
            GithubSignalingError::RateLimited => "github_signaling_rate_limited",
            GithubSignalingError::NotFound => "github_signaling_not_found",
            GithubSignalingError::Encode => "github_signaling_encode_failed",
            GithubSignalingError::Decode => "github_signaling_decode_failed",
            GithubSignalingError::CredentialStoreUnavailable => "github_signaling_credential_store_unavailable",
        };
        write!(f, "{code}")
    }
}

// -------------------------------------------------------------------------------------------
// Token storage — a dedicated keyring service, deliberately separate from
// `sync_security.rs`'s `DEVICE_KEY_SERVICE` (that one holds keys Alethe itself generated; this
// one holds a user-supplied GitHub credential with a different lifecycle: the user can revoke it
// on GitHub's side at any time, and it is optional — most sessions never touch this channel).
// -------------------------------------------------------------------------------------------

fn token_entry() -> Result<keyring::Entry, GithubSignalingError> {
    keyring::Entry::new(GITHUB_SIGNALING_SERVICE, GITHUB_SIGNALING_TOKEN_ENTRY)
        .map_err(|_| GithubSignalingError::CredentialStoreUnavailable)
}

pub fn store_token(token: &str) -> Result<(), GithubSignalingError> {
    token_entry()?.set_secret(token.as_bytes()).map_err(|_| GithubSignalingError::CredentialStoreUnavailable)
}

pub fn load_token() -> Result<Option<String>, GithubSignalingError> {
    match token_entry()?.get_secret() {
        Ok(secret) => String::from_utf8(secret).map(Some).map_err(|_| GithubSignalingError::Decode),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => {
            // "The keychain is locked", "the app lost its entitlement" and "the service is not
            // running" all reduced to one error code, and the remedy differs for each.
            crate::decide!(
                target: "sync.signaling",
                attempted = "load_token",
                outcome = Failed,
                because = "credential_read_failed",
                rule = "signaling.token.from_credential_store",
                evidence = { error = %error },
            );
            Err(GithubSignalingError::CredentialStoreUnavailable)
        }
    }
}

pub fn clear_token() -> Result<(), GithubSignalingError> {
    match token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => {
            crate::decide!(
                target: "sync.signaling",
                attempted = "clear_token",
                outcome = Failed,
                because = "credential_delete_failed",
                rule = "signaling.token.removable",
                evidence = { error = %error },
            );
            Err(GithubSignalingError::CredentialStoreUnavailable)
        }
    }
}

#[tauri::command]
pub async fn sync_github_signaling_set_token(token: String) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(GithubSignalingError::InvalidToken.to_string());
    }
    // Verify the token actually works (and carries at least read access) before persisting it —
    // storing a typo'd or already-revoked token silently would only surface as a confusing
    // failure much later, the first time the fallback channel is actually needed.
    verify_token(&token).await.map_err(|error| error.to_string())?;
    store_token(&token).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_github_signaling_clear_token() -> Result<(), String> {
    clear_token().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_github_signaling_has_token() -> Result<bool, String> {
    Ok(load_token().map_err(|error| error.to_string())?.is_some())
}

// -------------------------------------------------------------------------------------------
// GitHub Gist client — a mailbox keyed by a Gist id already known to both peers (exchanged via
// the pairing invitation, not discovered here), with one file per pairing session inside it.
// -------------------------------------------------------------------------------------------

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

fn auth(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
}

fn classify_status(status: reqwest::StatusCode) -> GithubSignalingError {
    match status.as_u16() {
        401 => GithubSignalingError::InvalidToken,
        403 => GithubSignalingError::RateLimited,
        404 => GithubSignalingError::NotFound,
        _ => GithubSignalingError::RequestFailed,
    }
}

async fn verify_token(token: &str) -> Result<(), GithubSignalingError> {
    let response = auth(http_client().get(format!("{GITHUB_API}/user")), token)
        .send()
        .await
        .map_err(|_| GithubSignalingError::RequestFailed)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(classify_status(response.status()))
    }
}

/// Deterministic, non-reversible filename for a pairing session inside the signaling Gist — the
/// raw `session_id` is not used directly as a filename so the Gist's file listing does not itself
/// leak which account routes are paired with each other to anyone who can list the (private, but
/// not secret) Gist.
fn session_file_name(session_id: &str) -> String {
    let digest = Sha256::digest(session_id.as_bytes());
    format!("alethe-session-{}.json", digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailboxEntry {
    sender_device_id: String,
    ciphertext: String,
    expires_at_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailboxFile {
    #[serde(default)]
    entries: Vec<MailboxEntry>,
}

/// Fetches a Gist's current file contents. `None` file map means the Gist itself does not exist
/// (or is not reachable with this token) — distinguished from an existing-but-empty session file,
/// which is a normal, expected state before either side has published anything yet.
async fn fetch_gist_files(token: &str, gist_id: &str) -> Result<serde_json::Map<String, serde_json::Value>, GithubSignalingError> {
    let response = auth(http_client().get(format!("{GITHUB_API}/gists/{gist_id}")), token)
        .send()
        .await
        .map_err(|_| GithubSignalingError::RequestFailed)?;
    if !response.status().is_success() {
        return Err(classify_status(response.status()));
    }
    let body: serde_json::Value = response.json().await.map_err(|_| GithubSignalingError::Decode)?;
    body.get("files")
        .and_then(|value| value.as_object())
        .cloned()
        .ok_or(GithubSignalingError::Decode)
}

async fn load_mailbox(token: &str, gist_id: &str, session_id: &str) -> Result<MailboxFile, GithubSignalingError> {
    let files = fetch_gist_files(token, gist_id).await?;
    let file_name = session_file_name(session_id);
    let Some(file) = files.get(&file_name) else {
        return Ok(MailboxFile::default());
    };
    let Some(content) = file.get("content").and_then(|value| value.as_str()) else {
        return Ok(MailboxFile::default());
    };
    serde_json::from_str(content).map_err(|_| GithubSignalingError::Decode)
}

async fn save_mailbox(token: &str, gist_id: &str, session_id: &str, mailbox: &MailboxFile) -> Result<(), GithubSignalingError> {
    let file_name = session_file_name(session_id);
    let content = serde_json::to_string(mailbox).map_err(|_| GithubSignalingError::Encode)?;
    let body = serde_json::json!({
        "description": GIST_DESCRIPTION,
        "files": { file_name: { "content": content } },
    });
    let response = auth(http_client().patch(format!("{GITHUB_API}/gists/{gist_id}")), token)
        .json(&body)
        .send()
        .await
        .map_err(|_| GithubSignalingError::RequestFailed)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(classify_status(response.status()))
    }
}

/// Drops expired entries and caps the retained count — called before every publish/read so a
/// mailbox never accumulates unbounded stale entries from abandoned sessions.
fn prune_mailbox(mailbox: &mut MailboxFile, now_ms: u64) {
    mailbox.entries.retain(|entry| entry.expires_at_ms > now_ms);
    if mailbox.entries.len() > MAX_ENTRIES_PER_SESSION_FILE {
        let overflow = mailbox.entries.len() - MAX_ENTRIES_PER_SESSION_FILE;
        mailbox.entries.drain(0..overflow);
    }
}

/// Publishes this device's already-sealed candidate ciphertext (produced by
/// `sync_p2p_bridge::sync_prepare_remote_candidate` — this function does not know or care what is
/// inside it) to the shared Gist, keyed by `session_id`. Read-modify-write against the Gist's
/// current content rather than blind-append, so two publishes racing on the same session still
/// converge instead of one clobbering the other's file update outright.
#[tauri::command]
pub async fn sync_github_signaling_publish_candidate(
    gist_id: String,
    session_id: String,
    sender_device_id: String,
    ciphertext: String,
) -> Result<(), String> {
    publish_candidate(&gist_id, &session_id, &sender_device_id, &ciphertext, crate::provider_common::now_ms())
        .await
        .map_err(|error| error.to_string())
}

async fn publish_candidate(
    gist_id: &str,
    session_id: &str,
    sender_device_id: &str,
    ciphertext: &str,
    now_ms: u64,
) -> Result<(), GithubSignalingError> {
    let token = load_token()?.ok_or(GithubSignalingError::NoToken)?;
    let mut mailbox = load_mailbox(&token, gist_id, session_id).await?;
    prune_mailbox(&mut mailbox, now_ms);
    mailbox.entries.retain(|entry| entry.sender_device_id != sender_device_id);
    mailbox.entries.push(MailboxEntry {
        sender_device_id: sender_device_id.to_string(),
        ciphertext: ciphertext.to_string(),
        expires_at_ms: now_ms + CANDIDATE_TTL_MS,
    });
    save_mailbox(&token, gist_id, session_id, &mailbox).await
}

/// Polls the shared Gist for a candidate ciphertext published by anyone other than
/// `local_device_id` for `session_id`. Returns `None` (not an error) when nothing new is there yet
/// — the caller (`useP2pAutoConnect.ts`'s fallback) is expected to poll this on an interval with
/// its own backoff/timeout, not treat an empty result as failure.
#[tauri::command]
pub async fn sync_github_signaling_poll_candidate(
    gist_id: String,
    session_id: String,
    local_device_id: String,
) -> Result<Option<String>, String> {
    poll_candidate(&gist_id, &session_id, &local_device_id, crate::provider_common::now_ms())
        .await
        .map_err(|error| error.to_string())
}

async fn poll_candidate(
    gist_id: &str,
    session_id: &str,
    local_device_id: &str,
    now_ms: u64,
) -> Result<Option<String>, GithubSignalingError> {
    let token = load_token()?.ok_or(GithubSignalingError::NoToken)?;
    let mailbox = load_mailbox(&token, gist_id, session_id).await?;
    Ok(mailbox
        .entries
        .iter()
        .find(|entry| entry.sender_device_id != local_device_id && entry.expires_at_ms > now_ms)
        .map(|entry| entry.ciphertext.clone()))
}

/// Clears this session's file from the mailbox once the candidate exchange is done (punch started
/// or the chat closed) — not strictly required for correctness (entries expire on their own via
/// `prune_mailbox`), but keeps the Gist from accumulating dead weight across many short sessions.
#[tauri::command]
pub async fn sync_github_signaling_cleanup_session(gist_id: String, session_id: String) -> Result<(), String> {
    cleanup_session(&gist_id, &session_id).await.map_err(|error| error.to_string())
}

async fn cleanup_session(gist_id: &str, session_id: &str) -> Result<(), GithubSignalingError> {
    let token = load_token()?.ok_or(GithubSignalingError::NoToken)?;
    let file_name = session_file_name(session_id);
    let body = serde_json::json!({ "files": { file_name: serde_json::Value::Null } });
    let response = auth(http_client().patch(format!("{GITHUB_API}/gists/{gist_id}")), &token)
        .json(&body)
        .send()
        .await
        .map_err(|_| GithubSignalingError::RequestFailed)?;
    if response.status().is_success() || response.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(classify_status(response.status()))
    }
}

/// Creates a fresh, empty signaling Gist under the caller's own GitHub account (their own token),
/// returning its id — meant to be called once per device, with the resulting id then embedded in
/// every future pairing invitation this device issues (`sync_invitation_bridge.rs`), not
/// re-created per session.
#[tauri::command]
pub async fn sync_github_signaling_create_gist() -> Result<String, String> {
    create_gist().await.map_err(|error| error.to_string())
}

async fn create_gist() -> Result<String, GithubSignalingError> {
    let token = load_token()?.ok_or(GithubSignalingError::NoToken)?;
    let body = serde_json::json!({
        "description": GIST_DESCRIPTION,
        "public": false,
        "files": { "README.md": { "content": "Alethe P2P signaling mailbox — safe to delete; entries expire on their own." } },
    });
    let response = auth(http_client().post(format!("{GITHUB_API}/gists")), &token)
        .json(&body)
        .send()
        .await
        .map_err(|_| GithubSignalingError::RequestFailed)?;
    if !response.status().is_success() {
        return Err(classify_status(response.status()));
    }
    let value: serde_json::Value = response.json().await.map_err(|_| GithubSignalingError::Decode)?;
    value
        .get("id")
        .and_then(|id| id.as_str())
        .map(|id| id.to_string())
        .ok_or(GithubSignalingError::Decode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_file_name_is_deterministic_and_does_not_leak_the_raw_session_id() {
        let name_a = session_file_name("route-a|route-b");
        let name_b = session_file_name("route-a|route-b");
        let name_c = session_file_name("route-a|route-c");
        assert_eq!(name_a, name_b);
        assert_ne!(name_a, name_c);
        assert!(!name_a.contains("route-a"));
        assert!(name_a.starts_with("alethe-session-"));
        assert!(name_a.ends_with(".json"));
    }

    #[test]
    fn prune_mailbox_drops_expired_entries_and_caps_retained_count() {
        let mut mailbox = MailboxFile {
            entries: vec![
                MailboxEntry { sender_device_id: "dev-old".to_string(), ciphertext: "c1".to_string(), expires_at_ms: 500 },
                MailboxEntry { sender_device_id: "dev-fresh".to_string(), ciphertext: "c2".to_string(), expires_at_ms: 5_000 },
            ],
        };
        prune_mailbox(&mut mailbox, 1_000);
        assert_eq!(mailbox.entries.len(), 1);
        assert_eq!(mailbox.entries[0].sender_device_id, "dev-fresh");

        let mut overflowing = MailboxFile {
            entries: (0..(MAX_ENTRIES_PER_SESSION_FILE + 5))
                .map(|i| MailboxEntry {
                    sender_device_id: format!("dev-{i}"),
                    ciphertext: "c".to_string(),
                    expires_at_ms: 10_000,
                })
                .collect(),
        };
        prune_mailbox(&mut overflowing, 1_000);
        assert_eq!(overflowing.entries.len(), MAX_ENTRIES_PER_SESSION_FILE);
        // The oldest (lowest-index) entries are the ones dropped, newest retained.
        assert_eq!(overflowing.entries.first().unwrap().sender_device_id, "dev-5");
    }

    #[test]
    fn mailbox_file_round_trips_through_json() {
        let mailbox = MailboxFile {
            entries: vec![MailboxEntry {
                sender_device_id: "dev-a".to_string(),
                ciphertext: "cGxhaW50ZXh0".to_string(),
                expires_at_ms: 123_456,
            }],
        };
        let serialized = serde_json::to_string(&mailbox).unwrap();
        let parsed: MailboxFile = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed.entries, mailbox.entries);
    }

    #[test]
    fn classify_status_maps_github_error_codes_to_the_right_variant() {
        assert_eq!(classify_status(reqwest::StatusCode::UNAUTHORIZED), GithubSignalingError::InvalidToken);
        assert_eq!(classify_status(reqwest::StatusCode::NOT_FOUND), GithubSignalingError::NotFound);
        assert_eq!(classify_status(reqwest::StatusCode::FORBIDDEN), GithubSignalingError::RateLimited);
        assert_eq!(classify_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR), GithubSignalingError::RequestFailed);
    }

    #[allow(dead_code)]
    fn assert_send<T: Send>() {}
    #[test]
    fn signaling_error_is_send_for_use_across_the_tauri_async_boundary() {
        assert_send::<GithubSignalingError>();
    }

    /// End-to-end against the real GitHub API only runs when a token is explicitly provided via
    /// env var — never in normal CI/local runs, since it requires a live network call and a real
    /// account. Exercises publish → poll (by the "other" device) → cleanup against a Gist the test
    /// creates and leaves for manual inspection if it fails.
    #[test]
    #[ignore = "requires ALETHE_TEST_GITHUB_TOKEN and network access — run explicitly, not in CI"]
    fn live_publish_poll_cleanup_round_trip() {
        let Ok(token) = std::env::var("ALETHE_TEST_GITHUB_TOKEN") else { return };
        store_token(&token).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let gist_id = create_gist().await.unwrap();
            let session_id = format!("test-session-{}", nanoid::nanoid!(8));
            let now = crate::provider_common::now_ms();
            publish_candidate(&gist_id, &session_id, "device-a", "ciphertext-a", now).await.unwrap();
            let seen = poll_candidate(&gist_id, &session_id, "device-b", now).await.unwrap();
            assert_eq!(seen.as_deref(), Some("ciphertext-a"));
            // The publishing device itself must never see its own entry as "the peer's".
            let seen_by_self = poll_candidate(&gist_id, &session_id, "device-a", now).await.unwrap();
            assert_eq!(seen_by_self, None);
            cleanup_session(&gist_id, &session_id).await.unwrap();
        });
        crate::best_effort!(clear_token(), "test_token_already_cleared");
    }
}

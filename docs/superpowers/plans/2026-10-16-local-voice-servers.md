# Local Voice Servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let narration speak through a text-to-speech server the person runs themselves (OpenAI-compatible such as Chatterbox / Kokoro-FastAPI, or Fish Speech) on this computer or the local network.

**Architecture:** A new Rust module `src-tauri/src/voice_servers/` owns the per-profile server list (`voice-servers.json`), the optional keychain key, a network policy that only lets requests reach loopback or private addresses (DNS checked and pinned per request), two request adapters, and a capped HTTP client. `tts_speak` gains a `server` provider that synthesizes chunk by chunk through it and falls back to the system voice. The frontend adds a `server` narration choice, a "Local servers" group in the Voice page, a server detail form, and server cards in the Narration panel.

**Tech Stack:** Rust (Tauri 2, reqwest 0.12, tokio, symphonia, nanoid, keyring via `secure_store`, tiny_http for tests), React + TypeScript, Zustand, Vitest, CSS Modules.

**Spec:** `docs/superpowers/specs/2026-10-16-local-voice-servers-design.md`

## Global Constraints

- **No commits.** The owner commits (CLAUDE.md §3.2). Each task ends with a checkpoint, never `git commit`.
- **Do not start, stop or restart `npm run app` / Vite.** HMR applies frontend changes.
- **Other sessions edit `src-tauri/src/tts.rs`, `voice_providers/*` and the voice UI.** Re-read every file right before editing it; anchor edits on symbol names, never on line numbers from this plan.
- All versioned text in English. Every visible string through `t()`, with the key in `en.ts`, `pt-BR.ts` and `zh-CN.ts`.
- Colors and spacing only through `src/styles/theme.css` tokens; one `.module.css` per component; no gradients.
- Allowed addresses: `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fe80::/10`, `fc00::/7` (IPv4-mapped IPv6 judged as its IPv4). Everything else refused.
- Timeouts: 120 s per speech chunk, 10 s for test and voice listing. Reply cap 50 MB (speech), 1 MB (listing).
- Limits: 32 servers, name ≤ 64 chars, model ≤ 128 chars, ≤ 500 voices of ≤ 128 chars.
- Logs and events carry the server id and error kind only — never the URL, key, response body or narrated text.
- `CHANGELOG.md` `[Unreleased]` updated in the same change.

**Deliberate deviations from the spec (decided while planning):**
- Ids are `nanoid` (21 chars, already a dependency), not UUID v4.
- `hasKey` is persisted in `voice-servers.json` so listing never touches the keychain (a keychain read can block on a macOS password prompt).
- No `voice_servers_voices` command: `tts_voices` with `provider: "server"` serves the voice list.
- Server card status is the last test result in this session (connected / invalid key / not connected); there is no separate "Not tested" label.
- The voice is chosen in the Narration panel (as for every provider), not in the server detail.
- `TtsChoice.server` is optional (`server?: string | null`) so existing literals stay valid.
- Adapters live together in `adapter.rs` (both are small).

## Review Focus

1. **A hostname that resolves to a public address** (`localhost.evil.example`, a split-horizon name) must be refused at save and at every request — tested in Task 1 (`mixed_resolution_is_refused`) and Task 5 (`public_ip_literal_is_refused_without_connecting`).
2. **A system HTTP proxy** must never carry narration to the outside — the client uses `no_proxy()` (Task 5, asserted by `client_ignores_proxy_env`).
3. **A server that answers with a redirect or a huge body** must not be followed or fill RAM — Task 5 tests `redirect_is_not_followed` and `oversized_reply_is_bad_audio`.
4. **A narration choice pointing at a deleted server** must speak with the system voice and show a warning — Task 6 (`missing_server_reads_as_missing`), Task 8 (`inUseWarnings` test).
5. **Deleting a profile** must delete the keychain keys of its servers — Task 4 (`delete_profile_keys_removes_every_server_key`).

---

### Task 1: Module skeleton, error kinds and network policy

**Files:**
- Create: `src-tauri/src/voice_servers/mod.rs`
- Create: `src-tauri/src/voice_servers/error.rs`
- Create: `src-tauri/src/voice_servers/netpolicy.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod voice_servers;` next to `mod voice_providers;`)

**Interfaces:**
- Produces:
  - `voice_servers::error::ServerErrorKind` (`Policy | Network | Timeout | Auth | BadRequest | BadAudio | Missing | Other`), `Serialize` camelCase, `Display` → `voice_server_{code}`, `fn code(self) -> &'static str`, `fn classify_status(status: u16) -> ServerErrorKind`.
  - `netpolicy::allowed_ip(IpAddr) -> bool`, `netpolicy::parse_base(&str) -> Result<reqwest::Url, ServerErrorKind>`, `netpolicy::base_string(&Url) -> String`, `netpolicy::endpoint(&Url, &str) -> String`, `netpolicy::check_addrs(&[SocketAddr]) -> Result<bool, ServerErrorKind>` (Ok(true) = all loopback), `netpolicy::Target { url, host, addrs, loopback }`, `async netpolicy::resolve(&Url) -> Result<Target, ServerErrorKind>`.

- [ ] **Step 1: Create the module root**

`src-tauri/src/voice_servers/mod.rs`:

```rust
//! Text-to-speech servers the person runs themselves (OpenAI-compatible or Fish Speech), reached
//! over HTTP on this computer or the local network. The list and keys stay on the Rust side; the
//! webview only passes a server id.

pub mod error;
pub mod netpolicy;
```

In `src-tauri/src/lib.rs`, add `mod voice_servers;` in the alphabetical `mod` list right after `mod voice_providers;` (search for that line).

- [ ] **Step 2: Write the error kinds with their tests**

`src-tauri/src/voice_servers/error.rs`:

```rust
use std::fmt;

use serde::Serialize;

/// Why a local voice server could not be used. Codes only: no URL, body or text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerErrorKind {
    Policy,
    Network,
    Timeout,
    Auth,
    BadRequest,
    BadAudio,
    Missing,
    Other,
}

impl ServerErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::Policy => "policy",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Auth => "auth",
            Self::BadRequest => "badRequest",
            Self::BadAudio => "badAudio",
            Self::Missing => "missing",
            Self::Other => "other",
        }
    }
}

impl fmt::Display for ServerErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "voice_server_{}", self.code())
    }
}

pub fn classify_status(status: u16) -> ServerErrorKind {
    match status {
        401 | 403 => ServerErrorKind::Auth,
        400 | 404 | 422 => ServerErrorKind::BadRequest,
        408 | 504 => ServerErrorKind::Timeout,
        _ => ServerErrorKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_kinds() {
        assert_eq!(classify_status(401), ServerErrorKind::Auth);
        assert_eq!(classify_status(403), ServerErrorKind::Auth);
        assert_eq!(classify_status(404), ServerErrorKind::BadRequest);
        assert_eq!(classify_status(422), ServerErrorKind::BadRequest);
        assert_eq!(classify_status(504), ServerErrorKind::Timeout);
        assert_eq!(classify_status(500), ServerErrorKind::Other);
        assert_eq!(classify_status(302), ServerErrorKind::Other);
    }

    #[test]
    fn display_is_a_code() {
        assert_eq!(ServerErrorKind::BadRequest.to_string(), "voice_server_badRequest");
    }
}
```

Add `pub mod error;` is already in `mod.rs` from Step 1.

- [ ] **Step 3: Write the failing network policy tests**

`src-tauri/src/voice_servers/netpolicy.rs` — start with the tests module only plus `use` lines, so it fails to compile:

```rust
//! Which addresses a local voice server may have: loopback and private ranges only. Checked when a
//! server is saved and again before every request, and the request is pinned to the checked
//! addresses so DNS cannot change between check and connect.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use reqwest::Url;

use super::error::ServerErrorKind;

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(raw: &str) -> IpAddr {
        raw.parse().unwrap()
    }

    #[test]
    fn private_and_loopback_ranges_are_allowed() {
        for raw in [
            "127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.0.1", "172.31.255.254",
            "192.168.1.20", "::1", "fe80::1", "fd12:3456::1", "fc00::1", "::ffff:192.168.0.2",
        ] {
            assert!(allowed_ip(ip(raw)), "{raw}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        for raw in [
            "8.8.8.8", "172.15.0.1", "172.32.0.1", "169.254.169.254", "0.0.0.0", "::",
            "224.0.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "100.64.0.1",
        ] {
            assert!(!allowed_ip(ip(raw)), "{raw}");
        }
    }

    #[test]
    fn base_urls_are_plain_http_or_https_hosts() {
        assert!(parse_base("http://localhost:4123").is_ok());
        assert!(parse_base(" https://192.168.0.5:8080/api/ ").is_ok());
        for bad in [
            "ftp://localhost", "file:///etc/passwd", "http://user:pw@localhost",
            "http://localhost/?x=1", "http://localhost/#frag", "localhost:4123", "",
        ] {
            assert_eq!(parse_base(bad), Err(ServerErrorKind::Policy), "{bad}");
        }
    }

    #[test]
    fn base_string_and_endpoint_drop_the_trailing_slash() {
        let url = parse_base("http://localhost:4123/").unwrap();
        assert_eq!(base_string(&url), "http://localhost:4123");
        assert_eq!(endpoint(&url, "/v1/tts"), "http://localhost:4123/v1/tts");
        let prefixed = parse_base("http://10.0.0.2/tts/").unwrap();
        assert_eq!(endpoint(&prefixed, "/v1/audio/speech"), "http://10.0.0.2/tts/v1/audio/speech");
    }

    #[test]
    fn mixed_resolution_is_refused() {
        let local: SocketAddr = "127.0.0.1:80".parse().unwrap();
        let public: SocketAddr = "93.184.216.34:80".parse().unwrap();
        assert_eq!(check_addrs(&[local, public]), Err(ServerErrorKind::Policy));
        assert_eq!(check_addrs(&[]), Err(ServerErrorKind::Policy));
        assert_eq!(check_addrs(&[local]), Ok(true));
        let lan: SocketAddr = "192.168.0.9:80".parse().unwrap();
        assert_eq!(check_addrs(&[local, lan]), Ok(false));
    }

    #[tokio::test]
    async fn ip_literals_resolve_without_dns() {
        let target = resolve(&parse_base("http://[::1]:4123").unwrap()).await.unwrap();
        assert_eq!(target.host, "::1");
        assert!(target.loopback);
        assert_eq!(
            resolve(&parse_base("http://8.8.8.8").unwrap()).await.err(),
            Some(ServerErrorKind::Policy)
        );
    }
}
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd src-tauri && cargo test voice_servers::netpolicy`
Expected: compile errors `cannot find function allowed_ip` (and the others).

- [ ] **Step 5: Implement the policy above the tests module**

```rust
/// IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is judged as the IPv4 address it carries.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

pub fn allowed_ip(ip: IpAddr) -> bool {
    match canonical(ip) {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            a == 127 || a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
        }
        IpAddr::V6(v6) => {
            let head = v6.segments()[0];
            v6 == Ipv6Addr::LOCALHOST || head & 0xffc0 == 0xfe80 || head & 0xfe00 == 0xfc00
        }
    }
}

/// A server base URL: `http`/`https`, a host, no credentials, query or fragment. A path prefix is
/// kept for servers behind a reverse proxy.
pub fn parse_base(raw: &str) -> Result<Url, ServerErrorKind> {
    let url = Url::parse(raw.trim()).map_err(|_| ServerErrorKind::Policy)?;
    let valid = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    if valid {
        Ok(url)
    } else {
        Err(ServerErrorKind::Policy)
    }
}

/// The base URL as stored: no trailing slash.
pub fn base_string(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// `path` (starting with `/`) under the base URL.
pub fn endpoint(base: &Url, path: &str) -> String {
    format!("{}{path}", base_string(base))
}

/// Ok(true) when every address is loopback, Ok(false) when some are on the local network.
pub fn check_addrs(addrs: &[SocketAddr]) -> Result<bool, ServerErrorKind> {
    if addrs.is_empty() || !addrs.iter().all(|addr| allowed_ip(addr.ip())) {
        return Err(ServerErrorKind::Policy);
    }
    Ok(addrs.iter().all(|addr| canonical(addr.ip()).is_loopback()))
}

/// A checked base URL and the addresses requests must connect to.
#[derive(Clone, Debug)]
pub struct Target {
    pub url: Url,
    /// Host without IPv6 brackets.
    pub host: String,
    pub addrs: Vec<SocketAddr>,
    pub loopback: bool,
}

pub async fn resolve(url: &Url) -> Result<Target, ServerErrorKind> {
    let host = url
        .host_str()
        .ok_or(ServerErrorKind::Policy)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default().ok_or(ServerErrorKind::Policy)?;
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| ServerErrorKind::Network)?
        .collect();
    let loopback = check_addrs(&addrs)?;
    Ok(Target {
        url: url.clone(),
        host,
        addrs,
        loopback,
    })
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd src-tauri && cargo test voice_servers::`
Expected: all `voice_servers::error` and `voice_servers::netpolicy` tests PASS.

- [ ] **Step 7: Checkpoint (no commit)**

Run: `cd src-tauri && cargo clippy --all-targets -- -D warnings 2>&1 | grep voice_servers || true`
Expected: no warnings in `voice_servers`. Unused-item warnings for items used by later tasks are acceptable until Task 5; do not silence them with `#[allow]`.

---

### Task 2: Server ids and keychain keys per server

**Files:**
- Create: `src-tauri/src/voice_servers/id.rs`
- Modify: `src-tauri/src/voice_servers/mod.rs`
- Modify: `src-tauri/src/secure_store.rs` (`SecretKind`, `suffix`, tests)
- Modify: `src-tauri/src/voice_providers/keys.rs` (`KeyCache` keyed by `SecretKind`, new secret helpers)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `voice_servers::id::ServerId` — `Copy + Eq + Hash`, `ServerId::new()`, `ServerId::parse(&str) -> Option<ServerId>`, `as_str(&self) -> &str`, serde as a string.
  - `SecretKind::VoiceServerKey(ServerId)` with account suffix `voice-server-{id}`.
  - In `voice_providers::keys`: `pub(crate) async fn read_secret_async(app: &AppHandle, kind: SecretKind) -> Result<Option<String>, String>`, `pub(crate) async fn write_secret_async(app: &AppHandle, kind: SecretKind, value: String) -> Result<(), String>`, `pub(crate) async fn delete_secret_async(app: &AppHandle, kind: SecretKind) -> Result<(), String>`, `pub(crate) fn delete_secret(profile: &str, kind: SecretKind) -> Result<(), String>`.

- [ ] **Step 1: Write the failing id tests**

`src-tauri/src/voice_servers/id.rs`:

```rust
//! Server ids: nanoid strings (21 characters of `A-Za-z0-9_-`), stored inline so the id is `Copy`
//! and can live inside `SecretKind`.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const ID_LEN: usize = 21;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ids_parse_back() {
        let id = ServerId::new();
        assert_eq!(ServerId::parse(id.as_str()), Some(id));
        assert_ne!(ServerId::new(), id);
    }

    #[test]
    fn only_nanoid_shaped_strings_parse() {
        assert!(ServerId::parse("V1StGXR8_Z5jdHi6B-myT").is_some());
        for bad in ["", "short", "V1StGXR8_Z5jdHi6B-myT1", "V1StGXR8/Z5jdHi6B-myT", "../../../../../../../.."] {
            assert!(ServerId::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn serde_round_trips_as_a_string() {
        let id = ServerId::parse("V1StGXR8_Z5jdHi6B-myT").unwrap();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"V1StGXR8_Z5jdHi6B-myT\"");
        assert_eq!(serde_json::from_str::<ServerId>(&json).unwrap(), id);
        assert!(serde_json::from_str::<ServerId>("\"nope\"").is_err());
    }
}
```

Add `pub mod id;` to `voice_servers/mod.rs`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test voice_servers::id`
Expected: compile error `cannot find type ServerId`.

- [ ] **Step 3: Implement `ServerId` above the tests**

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ServerId([u8; ID_LEN]);

impl ServerId {
    pub fn new() -> Self {
        Self::parse(&nanoid::nanoid!()).expect("nanoid uses the id alphabet")
    }

    pub fn parse(raw: &str) -> Option<Self> {
        let bytes = raw.as_bytes();
        let valid = bytes.len() == ID_LEN
            && bytes
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-');
        if !valid {
            return None;
        }
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(bytes);
        Some(Self(id))
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("ids are ASCII")
    }
}

impl fmt::Debug for ServerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Display for ServerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ServerId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ServerId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).ok_or_else(|| serde::de::Error::custom("invalid server id"))
    }
}
```

Run: `cd src-tauri && cargo test voice_servers::id` — Expected: PASS.

- [ ] **Step 4: Write the failing keychain account test**

In `src-tauri/src/secure_store.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn voice_server_keys_are_per_server() {
        let id = crate::voice_servers::id::ServerId::parse("V1StGXR8_Z5jdHi6B-myT").unwrap();
        assert_eq!(
            account("default", SecretKind::VoiceServerKey(id)),
            "profile:default:voice-server-V1StGXR8_Z5jdHi6B-myT"
        );
    }
```

Run: `cd src-tauri && cargo test secure_store` — Expected: compile error `no variant VoiceServerKey`.

- [ ] **Step 5: Add the variant and an owned suffix**

In `secure_store.rs`:

1. Add `use std::borrow::Cow;` at the top.
2. Add the variant to `SecretKind`: `VoiceServerKey(crate::voice_servers::id::ServerId),`
3. Change `fn suffix(self) -> &'static str` to `fn suffix(self) -> Cow<'static, str>`; wrap every existing arm's string with `Cow::Borrowed(...)` (the `VoiceProviderKey` inner `match` becomes `Cow::Borrowed(match provider { ... })`), and add:

```rust
            Self::VoiceServerKey(id) => Cow::Owned(format!("voice-server-{id}")),
```

`account` keeps `format!("profile:{profile_id}:{}", kind.suffix())`. Fix any other `suffix()` caller the compiler reports (there should be none outside this file).

Run: `cd src-tauri && cargo test secure_store` — Expected: PASS.

- [ ] **Step 6: Write the failing generic key cache test**

In `src-tauri/src/voice_providers/keys.rs` `mod tests` (it already has `MemoryStore`), add:

```rust
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
```

Run: `cd src-tauri && cargo test voice_providers::keys` — Expected: compile error `no method write_kind`.

- [ ] **Step 7: Key the cache by `SecretKind`**

In `keys.rs`:

1. `KeyCache(Mutex<HashMap<(String, CloudProvider), Slot>>)` → `KeyCache(Mutex<HashMap<(String, SecretKind), Slot>>)`; update its doc to "for each (profile, secret)".
2. `fn slot(&self, profile: &str, provider: CloudProvider)` → `fn slot(&self, profile: &str, kind: SecretKind)`, inserting `(profile.to_string(), kind)`.
3. Rename the bodies of `read`, `write`, `delete` into `read_kind`, `write_kind`, `delete_kind` that take `kind: SecretKind` and use it directly (in place of `SecretKind::VoiceProviderKey(provider)`), then keep `read`, `write`, `delete` as one-line wrappers:

```rust
    pub(crate) fn read(&self, store: &impl SecretStore, profile: &str, provider: CloudProvider) -> Result<Option<String>, String> {
        self.read_kind(store, profile, SecretKind::VoiceProviderKey(provider))
    }
```

(and the same for `write` / `delete`). `delete_profile` is unchanged.

4. Below `delete_profile_keys`, add:

```rust
/// A secret of the active profile other than a provider key (a local voice server's key), read on
/// a blocking thread once per run.
pub(crate) async fn read_secret_async(app: &AppHandle, kind: SecretKind) -> Result<Option<String>, String> {
    let app = app.clone();
    blocking(move || KEYS.read_kind(&OsSecretStore, &active_profile_id(&app)?, kind)).await
}

pub(crate) async fn write_secret_async(app: &AppHandle, kind: SecretKind, value: String) -> Result<(), String> {
    let app = app.clone();
    blocking(move || KEYS.write_kind(&OsSecretStore, &active_profile_id(&app)?, kind, &value)).await
}

pub(crate) async fn delete_secret_async(app: &AppHandle, kind: SecretKind) -> Result<(), String> {
    let app = app.clone();
    blocking(move || KEYS.delete_kind(&OsSecretStore, &active_profile_id(&app)?, kind)).await
}

/// Removes one secret of `profile` (profile deletion, already on a blocking path).
pub(crate) fn delete_secret(profile: &str, kind: SecretKind) -> Result<(), String> {
    KEYS.delete_kind(&OsSecretStore, profile, kind)
}
```

5. `use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};` is already imported; nothing else changes.

- [ ] **Step 8: Run all key and store tests**

Run: `cd src-tauri && cargo test voice_providers::keys secure_store voice_servers::id`
Expected: PASS (the existing key tests still pass unchanged).

- [ ] **Step 9: Checkpoint (no commit)** — `git diff --stat src-tauri/src/secure_store.rs src-tauri/src/voice_providers/keys.rs` shows only the changes above.

---

### Task 3: Request adapters, voice parsing and audio decoding

**Files:**
- Create: `src-tauri/src/voice_servers/adapter.rs`
- Modify: `src-tauri/src/voice_servers/mod.rs` (`pub mod adapter;`)
- Modify: `src-tauri/src/voice_providers/tts_cloud.rs` (add `decode_audio`)
- Modify: `src-tauri/Cargo.toml` (`symphonia` features)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `adapter::ServerKind` (`Openai | Fish`, serde lowercase) — the store (Task 4) reuses it.
  - `adapter::SpeechRequest { path: &'static str, body: serde_json::Value }`
  - `adapter::speech_request(kind: ServerKind, model: Option<&str>, voice: Option<&str>, text: &str, rate: f32) -> SpeechRequest`
  - `adapter::voice_paths(kind) -> &'static [&'static str]`, `adapter::health_paths(kind) -> &'static [&'static str]`
  - `adapter::parse_voices(body: &[u8]) -> Vec<String>`
  - `adapter::playback_rate(kind, rate: f32, sample_rate: u32) -> u32`
  - `adapter::DEFAULT_OPENAI_MODEL: &str = "tts-1"`
  - `tts_cloud::decode_audio(body: &[u8]) -> Result<Pcm, CloudError>` (MP3 or WAV)

- [ ] **Step 1: Enable WAV decoding**

In `src-tauri/Cargo.toml` change the symphonia line and its comment to:

```toml
# Decodes compressed speech replies: OpenRouter MP3 (its PCM rate is model-dependent and
# undocumented) and local voice servers (MP3 or WAV).
symphonia = { version = "0.5", default-features = false, features = ["mp3", "wav", "pcm"] }
```

- [ ] **Step 2: Write the failing adapter tests**

`src-tauri/src/voice_servers/adapter.rs`:

```rust
//! What each server kind is asked and how its replies are read. Pure, so it is tested without a
//! server.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_speech_asks_for_mp3_with_model_voice_and_speed() {
        let request = speech_request(ServerKind::Openai, Some("chatterbox"), Some("pt-ref"), "Olá", 1.5);
        assert_eq!(request.path, "/v1/audio/speech");
        assert_eq!(
            request.body,
            json!({ "model": "chatterbox", "input": "Olá", "voice": "pt-ref", "response_format": "mp3", "speed": 1.5 })
        );
    }

    #[test]
    fn openai_defaults_the_model_and_omits_a_missing_voice() {
        let request = speech_request(ServerKind::Openai, None, None, "Hi", 9.0);
        assert_eq!(
            request.body,
            json!({ "model": "tts-1", "input": "Hi", "response_format": "mp3", "speed": 4.0 })
        );
    }

    #[test]
    fn fish_speech_sends_the_reference_id_and_never_speed() {
        let request = speech_request(ServerKind::Fish, Some("ignored"), Some("narrador"), "Olá", 1.5);
        assert_eq!(request.path, "/v1/tts");
        assert_eq!(
            request.body,
            json!({ "text": "Olá", "format": "mp3", "normalize": true, "reference_id": "narrador" })
        );
        let bare = speech_request(ServerKind::Fish, None, None, "x", 1.0);
        assert!(bare.body.get("reference_id").is_none());
    }

    #[test]
    fn voices_are_read_from_each_known_shape() {
        // Kokoro-FastAPI GET /v1/audio/voices
        assert_eq!(parse_voices(br#"{"voices":["af_bella","pf_dora"]}"#), ["af_bella", "pf_dora"]);
        // chatterbox-tts-api GET /voices
        assert_eq!(
            parse_voices(br#"{"voices":[{"name":"pt-ref","language":"pt"},{"name":"en-ref"}],"count":2}"#),
            ["pt-ref", "en-ref"]
        );
        // Fish Speech GET /v1/references/list
        assert_eq!(
            parse_voices(br#"{"success":true,"reference_ids":["narrador"],"message":""}"#),
            ["narrador"]
        );
        assert_eq!(parse_voices(br#"[{"id":"a"},{"voice_id":"b"},"c","c"," "]"#), ["a", "b", "c"]);
    }

    #[test]
    fn unknown_or_hostile_voice_replies_read_as_empty_or_capped() {
        assert!(parse_voices(b"<html>").is_empty());
        assert!(parse_voices(br#"{"data":[{"id":"tts-1"}]}"#).is_empty());
        let long = format!(r#"["{}"]"#, "x".repeat(MAX_VOICE_LEN + 1));
        assert!(parse_voices(long.as_bytes()).is_empty());
        let many: Vec<String> = (0..MAX_VOICES + 50).map(|i| format!("v{i}")).collect();
        assert_eq!(parse_voices(serde_json::to_string(&many).unwrap().as_bytes()).len(), MAX_VOICES);
    }

    #[test]
    fn only_fish_is_sped_up_by_the_player() {
        assert_eq!(playback_rate(ServerKind::Openai, 1.5, 24_000), 24_000);
        assert_eq!(playback_rate(ServerKind::Fish, 1.5, 44_100), 66_150);
    }

    #[test]
    fn kinds_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&ServerKind::Openai).unwrap(), "\"openai\"");
        assert_eq!(serde_json::from_str::<ServerKind>("\"fish\"").unwrap(), ServerKind::Fish);
    }

    #[test]
    fn wav_replies_decode() {
        let pcm = crate::voice_providers::tts_cloud::decode_audio(&tiny_wav(16_000, &[0, 8000, -8000, 0]))
            .expect("wav decodes");
        assert_eq!(pcm.sample_rate, 16_000);
        assert_eq!(pcm.samples.len(), 4);
        assert!(crate::voice_providers::tts_cloud::decode_audio(b"not audio").is_err());
    }

    /// A mono 16-bit PCM WAV file.
    pub(crate) fn tiny_wav(rate: u32, samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        out
    }
}
```

Add `pub mod adapter;` to `voice_servers/mod.rs`.

- [ ] **Step 3: Run to verify it fails**

Run: `cd src-tauri && cargo test voice_servers::adapter`
Expected: compile errors (`ServerKind`, `speech_request`, `decode_audio` not found).

- [ ] **Step 4: Add `decode_audio` to `tts_cloud.rs`**

Right after the `decode_mp3` function (search `fn decode_mp3`), add:

```rust
/// Decodes an MP3 or WAV reply (the probe reads the container from the bytes; the MP3 hint only
/// breaks ties) to mono samples at the stream's own rate.
pub fn decode_audio(body: &[u8]) -> Result<Pcm, CloudError> {
    decode_mp3(body)
}
```

- [ ] **Step 5: Implement the adapter above the tests module**

```rust
pub const DEFAULT_OPENAI_MODEL: &str = "tts-1";
pub const MAX_VOICES: usize = 500;
pub const MAX_VOICE_LEN: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    /// `POST /v1/audio/speech`: chatterbox-tts-api, Kokoro-FastAPI, openedai-speech, LocalAI.
    Openai,
    /// Fish Speech's own `POST /v1/tts`.
    Fish,
}

pub struct SpeechRequest {
    pub path: &'static str,
    pub body: Value,
}

pub fn speech_request(
    kind: ServerKind,
    model: Option<&str>,
    voice: Option<&str>,
    text: &str,
    rate: f32,
) -> SpeechRequest {
    match kind {
        ServerKind::Openai => {
            let mut body = json!({
                "model": model.unwrap_or(DEFAULT_OPENAI_MODEL),
                "input": text,
                "response_format": "mp3",
                "speed": rate.clamp(0.25, 4.0),
            });
            if let Some(voice) = voice {
                body["voice"] = json!(voice);
            }
            SpeechRequest { path: "/v1/audio/speech", body }
        }
        ServerKind::Fish => {
            let mut body = json!({ "text": text, "format": "mp3", "normalize": true });
            if let Some(voice) = voice {
                body["reference_id"] = json!(voice);
            }
            SpeechRequest { path: "/v1/tts", body }
        }
    }
}

/// Where each kind lists its voices, tried in order (servers differ).
pub fn voice_paths(kind: ServerKind) -> &'static [&'static str] {
    match kind {
        ServerKind::Openai => &["/v1/audio/voices", "/voices"],
        ServerKind::Fish => &["/v1/references/list"],
    }
}

/// Cheap GETs that prove the server is up and of this kind; the first that answers 2xx wins.
pub fn health_paths(kind: ServerKind) -> &'static [&'static str] {
    match kind {
        ServerKind::Openai => &["/v1/audio/voices", "/voices", "/v1/models"],
        ServerKind::Fish => &["/v1/health"],
    }
}

fn voice_id(item: &Value) -> Option<&str> {
    match item {
        Value::String(id) => Some(id),
        Value::Object(fields) => ["id", "voice_id", "name"]
            .iter()
            .find_map(|key| fields.get(*key)?.as_str()),
        _ => None,
    }
}

/// Voice ids from any of the known reply shapes; anything else is an empty list (the person then
/// types the voice).
pub fn parse_voices(body: &[u8]) -> Vec<String> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    let items = match &value {
        Value::Array(items) => items.as_slice(),
        Value::Object(fields) => ["voices", "reference_ids"]
            .iter()
            .find_map(|key| fields.get(*key)?.as_array())
            .map_or(&[][..], Vec::as_slice),
        _ => &[],
    };
    let mut out: Vec<String> = Vec::new();
    for id in items.iter().filter_map(voice_id).map(str::trim) {
        if id.is_empty() || id.chars().count() > MAX_VOICE_LEN || out.iter().any(|seen| seen == id) {
            continue;
        }
        out.push(id.to_string());
        if out.len() == MAX_VOICES {
            break;
        }
    }
    out
}

/// The rate to declare to the player: OpenAI-compatible servers apply `speed` themselves (or
/// ignore it); Fish has no speed, so the player plays faster or slower.
pub fn playback_rate(kind: ServerKind, rate: f32, sample_rate: u32) -> u32 {
    match kind {
        ServerKind::Openai => sample_rate,
        ServerKind::Fish => (sample_rate as f32 * rate).round() as u32,
    }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd src-tauri && cargo test voice_servers::adapter voice_providers::tts_cloud`
Expected: PASS (the existing `tts_cloud` tests still pass).

- [ ] **Step 7: Checkpoint (no commit)**

---

### Task 4: Server store and profile cleanup

**Files:**
- Create: `src-tauri/src/voice_servers/store.rs`
- Modify: `src-tauri/src/voice_servers/mod.rs` (`pub mod store;`, `delete_profile_keys`)
- Modify: `src-tauri/src/profiles.rs` (`delete_profile_state`)

**Interfaces:**
- Consumes: `ServerId` (Task 2), `ServerKind` (Task 3), `netpolicy::{parse_base, base_string}` (Task 1), `keys::delete_secret` (Task 2).
- Produces:
  - `store::VoiceServer { id: ServerId, name: String, kind: ServerKind, base_url: String, model: Option<String>, has_key: bool }` (serde camelCase).
  - `store::ServerInput { id: Option<String>, name: String, kind: ServerKind, base_url: String, model: Option<String> }` (Deserialize camelCase).
  - `store::FILE_NAME`, `store::MAX_SERVERS`, `store::load(dir: &Path) -> Vec<VoiceServer>`, `store::save(dir: &Path, servers: &[VoiceServer]) -> Result<(), String>`, `store::upsert(servers: &mut Vec<VoiceServer>, input: ServerInput) -> Result<VoiceServer, String>`, `store::remove(servers: &mut Vec<VoiceServer>, id: ServerId) -> bool`.
  - `voice_servers::delete_profile_keys(profile: &str, dir: &Path) -> Result<(), String>`.
  - Error codes (strings): `voice_server_policy`, `voice_server_invalidName`, `voice_server_invalidModel`, `voice_server_limit`, `voice_server_missing`.

- [ ] **Step 1: Write the failing store tests**

`src-tauri/src/voice_servers/store.rs`:

```rust
//! The active profile's voice servers in `{profile dir}/voice-servers.json`, written atomically.
//! Keys live in the keychain; the file only records whether a server has one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::adapter::ServerKind;
use super::error::ServerErrorKind;
use super::id::ServerId;
use super::netpolicy;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-voice-servers-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn input(name: &str, url: &str) -> ServerInput {
        ServerInput { id: None, name: name.into(), kind: ServerKind::Openai, base_url: url.into(), model: None }
    }

    #[test]
    fn missing_file_is_an_empty_list() {
        assert!(load(&temp_dir("missing")).is_empty());
    }

    #[test]
    fn saved_servers_load_back() {
        let dir = temp_dir("roundtrip");
        let mut servers = Vec::new();
        let saved = upsert(&mut servers, input("Chatterbox", "http://localhost:4123/")).unwrap();
        assert_eq!(saved.base_url, "http://localhost:4123");
        save(&dir, &servers).unwrap();
        assert_eq!(load(&dir), servers);
        assert!(!dir.join(format!("{FILE_NAME}.tmp")).exists());
    }

    #[test]
    fn corrupt_or_newer_files_read_as_empty_and_stay_on_disk() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join(FILE_NAME), "{not json").unwrap();
        assert!(load(&dir).is_empty());
        assert_eq!(std::fs::read_to_string(dir.join(FILE_NAME)).unwrap(), "{not json");
        std::fs::write(dir.join(FILE_NAME), r#"{"version":99,"servers":[]}"#).unwrap();
        assert!(load(&dir).is_empty());
    }

    #[test]
    fn upsert_validates_name_url_and_model() {
        let mut servers = Vec::new();
        assert_eq!(upsert(&mut servers, input("  ", "http://localhost")).unwrap_err(), "voice_server_invalidName");
        assert_eq!(upsert(&mut servers, input(&"n".repeat(65), "http://localhost")).unwrap_err(), "voice_server_invalidName");
        assert_eq!(upsert(&mut servers, input("x", "ftp://localhost")).unwrap_err(), "voice_server_policy");
        let mut long_model = input("x", "http://localhost");
        long_model.model = Some("m".repeat(129));
        assert_eq!(upsert(&mut servers, long_model).unwrap_err(), "voice_server_invalidModel");
        assert!(servers.is_empty());
    }

    #[test]
    fn fish_servers_drop_the_model_and_blank_models_are_none() {
        let mut servers = Vec::new();
        let mut fish = input("Fish", "http://127.0.0.1:8080");
        fish.kind = ServerKind::Fish;
        fish.model = Some("x".into());
        assert_eq!(upsert(&mut servers, fish).unwrap().model, None);
        let mut blank = input("Kokoro", "http://127.0.0.1:8880");
        blank.model = Some("  ".into());
        assert_eq!(upsert(&mut servers, blank).unwrap().model, None);
    }

    #[test]
    fn upsert_edits_by_id_and_keeps_has_key() {
        let mut servers = Vec::new();
        let first = upsert(&mut servers, input("A", "http://localhost:1")).unwrap();
        servers[0].has_key = true;
        let mut edit = input("B", "http://localhost:2");
        edit.id = Some(first.id.to_string());
        let edited = upsert(&mut servers, edit).unwrap();
        assert_eq!((edited.id, edited.name.as_str(), edited.has_key), (first.id, "B", true));
        assert_eq!(servers.len(), 1);
        let mut unknown = input("C", "http://localhost:3");
        unknown.id = Some("V1StGXR8_Z5jdHi6B-myT".into());
        assert_eq!(upsert(&mut servers, unknown).unwrap_err(), "voice_server_missing");
    }

    #[test]
    fn the_list_is_capped() {
        let mut servers = Vec::new();
        for index in 0..MAX_SERVERS {
            upsert(&mut servers, input(&format!("s{index}"), "http://localhost")).unwrap();
        }
        assert_eq!(upsert(&mut servers, input("one more", "http://localhost")).unwrap_err(), "voice_server_limit");
    }

    #[test]
    fn remove_reports_whether_it_found_the_server() {
        let mut servers = Vec::new();
        let saved = upsert(&mut servers, input("A", "http://localhost")).unwrap();
        assert!(remove(&mut servers, saved.id));
        assert!(!remove(&mut servers, saved.id));
    }
}
```

Add `pub mod store;` to `voice_servers/mod.rs`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test voice_servers::store`
Expected: compile errors (`load`, `save`, `upsert` … not found).

- [ ] **Step 3: Implement the store above the tests**

```rust
pub const FILE_NAME: &str = "voice-servers.json";
const VERSION: u32 = 1;
pub const MAX_SERVERS: usize = 32;
const MAX_NAME: usize = 64;
const MAX_MODEL: usize = 128;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceServer {
    pub id: ServerId,
    pub name: String,
    pub kind: ServerKind,
    pub base_url: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Whether a key is in the keychain, so listing never reads the keychain.
    #[serde(default)]
    pub has_key: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: ServerKind,
    pub base_url: String,
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    servers: Vec<VoiceServer>,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The saved servers. A missing file is an empty list; an unreadable or newer one is logged and
/// read as empty, and left on disk until the next save.
pub fn load(dir: &Path) -> Vec<VoiceServer> {
    let Ok(text) = std::fs::read_to_string(path(dir)) else {
        return Vec::new();
    };
    match serde_json::from_str::<StoreFile>(&text) {
        Ok(file) if file.version == VERSION => file.servers,
        _ => {
            eprintln!("[voice_servers] {FILE_NAME} unreadable; using an empty list");
            Vec::new()
        }
    }
}

pub fn save(dir: &Path, servers: &[VoiceServer]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&StoreFile { version: VERSION, servers: servers.to_vec() })
        .map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path(dir)).map_err(|e| e.to_string())
}

fn code(kind: &str) -> String {
    format!("voice_server_{kind}")
}

/// Creates (no id) or edits (id) a server after checking its fields; the address is checked for
/// shape only here; its resolution is checked by the caller.
pub fn upsert(servers: &mut Vec<VoiceServer>, input: ServerInput) -> Result<VoiceServer, String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(code("invalidName"));
    }
    let url = netpolicy::parse_base(&input.base_url).map_err(|_| ServerErrorKind::Policy.to_string())?;
    let model = match input.model.as_deref().map(str::trim) {
        Some(model) if model.chars().count() > MAX_MODEL => return Err(code("invalidModel")),
        Some(model) if !model.is_empty() && input.kind == ServerKind::Openai => Some(model.to_string()),
        _ => None,
    };
    let base_url = netpolicy::base_string(&url);
    match input.id {
        Some(raw) => {
            let id = ServerId::parse(&raw).ok_or_else(|| code("missing"))?;
            let entry = servers.iter_mut().find(|server| server.id == id).ok_or_else(|| code("missing"))?;
            entry.name = name.to_string();
            entry.kind = input.kind;
            entry.base_url = base_url;
            entry.model = model;
            Ok(entry.clone())
        }
        None => {
            if servers.len() >= MAX_SERVERS {
                return Err(code("limit"));
            }
            let server = VoiceServer {
                id: ServerId::new(),
                name: name.to_string(),
                kind: input.kind,
                base_url,
                model,
                has_key: false,
            };
            servers.push(server.clone());
            Ok(server)
        }
    }
}

pub fn remove(servers: &mut Vec<VoiceServer>, id: ServerId) -> bool {
    let before = servers.len();
    servers.retain(|server| server.id != id);
    servers.len() != before
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test voice_servers::store`
Expected: PASS.

- [ ] **Step 5: Write the failing profile-cleanup test**

In `voice_servers/mod.rs`, add `pub mod store;` (if not yet) and a test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_profile_keys_removes_every_server_key() {
        let dir = std::env::temp_dir().join(format!("alethe-voice-servers-profile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut servers = Vec::new();
        for name in ["a", "b"] {
            let input = store::ServerInput {
                id: None,
                name: name.into(),
                kind: adapter::ServerKind::Openai,
                base_url: "http://localhost".into(),
                model: None,
            };
            store::upsert(&mut servers, input).unwrap();
        }
        store::save(&dir, &servers).unwrap();
        let mut deleted = Vec::new();
        server_key_kinds(&dir, |kind| {
            deleted.push(kind);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            deleted,
            servers.iter().map(|s| crate::secure_store::SecretKind::VoiceServerKey(s.id)).collect::<Vec<_>>()
        );
    }
}
```

Run: `cd src-tauri && cargo test voice_servers::tests` — Expected: compile error `server_key_kinds` not found.

- [ ] **Step 6: Implement profile cleanup**

In `voice_servers/mod.rs` (above the tests):

```rust
use std::path::Path;

use crate::secure_store::SecretKind;

/// Runs `delete` for the key of every server saved in `dir`; every key is tried, the first error is
/// reported.
fn server_key_kinds(dir: &Path, mut delete: impl FnMut(SecretKind) -> Result<(), String>) -> Result<(), String> {
    let mut first_error = None;
    for server in store::load(dir) {
        if let Err(error) = delete(SecretKind::VoiceServerKey(server.id)) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Removes the keychain keys of a profile's voice servers (profile deletion).
pub fn delete_profile_keys(profile: &str, dir: &Path) -> Result<(), String> {
    server_key_kinds(dir, |kind| crate::voice_providers::keys::delete_secret(profile, kind))
}
```

In `src-tauri/src/profiles.rs`, `delete_profile_state`, right after the line `crate::voice_providers::keys::delete_profile_keys(&target.id)?;` add:

```rust
    crate::voice_servers::delete_profile_keys(&target.id, &target_dir)?;
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd src-tauri && cargo test voice_servers:: profiles`
Expected: PASS.

- [ ] **Step 8: Checkpoint (no commit)**

---

### Task 5: Pinned HTTP client and Tauri commands

**Files:**
- Create: `src-tauri/src/voice_servers/client.rs`
- Create: `src-tauri/src/voice_servers/commands.rs`
- Modify: `src-tauri/src/voice_servers/mod.rs` (`pub mod client; pub mod commands;`, `find_active`, `voices_for`, `active_dir`)
- Modify: `src-tauri/src/lib.rs` (register commands)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `client::synthesize(server: &VoiceServer, key: Option<&str>, voice: Option<&str>, text: &str, rate: f32) -> Result<Pcm, ServerErrorKind>`
  - `client::voices(server: &VoiceServer, key: Option<&str>) -> Result<Vec<String>, ServerErrorKind>`
  - `client::health(server: &VoiceServer, key: Option<&str>) -> Result<(), ServerErrorKind>`
  - `voice_servers::active_dir(app) -> Result<(String, PathBuf), String>` (profile id, dir)
  - `voice_servers::find_active(app, id: &str) -> Option<VoiceServer>`
  - `voice_servers::server_key(app, server: &VoiceServer) -> Result<Option<String>, ServerErrorKind>`
  - `voice_servers::voices_for(app, id: &str) -> Vec<String>`
  - Commands: `voice_servers_list() -> Vec<VoiceServer>`, `voice_servers_save(input: ServerInput, key: Option<String>) -> Result<SavedServer, String>` (`SavedServer { server, loopback }`), `voice_servers_delete(id: String) -> Result<(), String>`, `voice_servers_test(id: String) -> ServerTest` (`ServerTest { ok, reason: Option<ServerErrorKind>, voices: Vec<String>, loopback: bool }`).

- [ ] **Step 1: Write the failing client tests (fake server with tiny_http)**

`src-tauri/src/voice_servers/client.rs`:

```rust
//! HTTP to a local voice server: its own client per request, pinned to the addresses the policy
//! checked, no proxy, no redirects, capped replies.

use std::net::IpAddr;
use std::time::Duration;

use serde_json::Value;

use super::adapter::{self, ServerKind};
use super::error::{classify_status, ServerErrorKind};
use super::netpolicy::{self, Target};
use super::store::VoiceServer;
use crate::voice_providers::tts_cloud::{self, Pcm};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_servers::id::ServerId;

    /// Serves `routes` (path → (status, headers, body)) on 127.0.0.1 for `count` requests, and
    /// returns the base URL and a channel with what each request carried.
    fn fake(routes: Vec<(&'static str, u16, Vec<(&'static str, &'static str)>, Vec<u8>)>, count: usize)
        -> (String, std::sync::mpsc::Receiver<(String, Option<String>, String)>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests().take(count) {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let auth = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.to_string());
                let path = request.url().to_string();
                let _ = tx.send((path.clone(), auth, body));
                let (status, headers, reply) = routes
                    .iter()
                    .find(|(route, ..)| *route == path)
                    .map(|(_, status, headers, body)| (*status, headers.clone(), body.clone()))
                    .unwrap_or((404, Vec::new(), Vec::new()));
                let mut response = tiny_http::Response::from_data(reply).with_status_code(status);
                for (name, value) in headers {
                    response.add_header(tiny_http::Header::from_bytes(name, value).unwrap());
                }
                let _ = request.respond(response);
            }
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    fn server(kind: ServerKind, base_url: &str) -> VoiceServer {
        VoiceServer {
            id: ServerId::new(),
            name: "test".into(),
            kind,
            base_url: base_url.into(),
            model: None,
            has_key: false,
        }
    }

    use std::io::Read as _;

    #[tokio::test]
    async fn speech_is_posted_and_wav_is_decoded() {
        let wav = crate::voice_servers::adapter::tests::tiny_wav(22_050, &[0, 1000, -1000, 0]);
        let (base, seen) = fake(vec![("/v1/tts", 200, vec![("Content-Type", "audio/wav")], wav)], 1);
        let pcm = synthesize(&server(ServerKind::Fish, &base), Some("k"), Some("narrador"), "Olá", 1.0)
            .await
            .unwrap();
        assert_eq!(pcm.sample_rate, 22_050);
        let (path, auth, body) = seen.recv().unwrap();
        assert_eq!(path, "/v1/tts");
        assert_eq!(auth.as_deref(), Some("Bearer k"));
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["reference_id"], "narrador");
    }

    #[tokio::test]
    async fn rejected_key_reads_as_auth() {
        let (base, _) = fake(vec![("/v1/audio/speech", 401, vec![], Vec::new())], 1);
        let error = synthesize(&server(ServerKind::Openai, &base), None, None, "x", 1.0).await.unwrap_err();
        assert_eq!(error, ServerErrorKind::Auth);
    }

    #[tokio::test]
    async fn redirect_is_not_followed() {
        let (base, seen) = fake(
            vec![("/v1/audio/speech", 302, vec![("Location", "http://127.0.0.1:9/evil")], Vec::new())],
            1,
        );
        let error = synthesize(&server(ServerKind::Openai, &base), None, None, "x", 1.0).await.unwrap_err();
        assert_eq!(error, ServerErrorKind::Other);
        assert_eq!(seen.recv().unwrap().0, "/v1/audio/speech");
        assert!(seen.try_recv().is_err());
    }

    #[tokio::test]
    async fn oversized_reply_is_bad_audio() {
        let (base, _) = fake(vec![("/voices", 200, vec![], vec![b' '; 64])], 1);
        let target = netpolicy::resolve(&netpolicy::parse_base(&base).unwrap()).await.unwrap();
        let error = get(&target, "/voices", None, PROBE_TIMEOUT, 16).await.unwrap_err();
        assert_eq!(error, ServerErrorKind::BadAudio);
    }

    #[tokio::test]
    async fn voices_fall_through_to_the_next_known_path() {
        let (base, _) = fake(vec![("/voices", 200, vec![], br#"{"voices":[{"name":"pt-ref"}]}"#.to_vec())], 2);
        let voices = voices(&server(ServerKind::Openai, &base), None).await.unwrap();
        assert_eq!(voices, ["pt-ref"]);
    }

    #[tokio::test]
    async fn health_of_the_wrong_kind_is_bad_request() {
        let (base, _) = fake(Vec::new(), 1);
        assert_eq!(health(&server(ServerKind::Fish, &base), None).await, Err(ServerErrorKind::BadRequest));
    }

    #[tokio::test]
    async fn public_ip_literal_is_refused_without_connecting() {
        let error = synthesize(&server(ServerKind::Openai, "http://8.8.8.8"), None, None, "x", 1.0)
            .await
            .unwrap_err();
        assert_eq!(error, ServerErrorKind::Policy);
    }

    #[tokio::test]
    async fn closed_port_is_network() {
        let error = synthesize(&server(ServerKind::Openai, "http://127.0.0.1:9"), None, None, "x", 1.0)
            .await
            .unwrap_err();
        assert_eq!(error, ServerErrorKind::Network);
    }

    #[test]
    fn client_ignores_proxy_env() {
        // `no_proxy()` is what keeps a system proxy from carrying narration out; this guards the
        // builder against a refactor that drops it.
        assert!(include_str!("client.rs").contains(".no_proxy()"));
    }
}
```

Add `pub mod client;` to `voice_servers/mod.rs`. Make the `tiny_wav` helper reachable: in `adapter.rs` change `mod tests` to `pub(crate) mod tests` (the helper is already `pub(crate)`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test voice_servers::client`
Expected: compile errors (`synthesize`, `get`, `voices`, `health`, `PROBE_TIMEOUT` not found).

- [ ] **Step 3: Implement the client above the tests**

```rust
pub const SPEECH_TIMEOUT: Duration = Duration::from_secs(120);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SPEECH_BYTES: usize = 50 * 1024 * 1024;
const MAX_PROBE_BYTES: usize = 1024 * 1024;

fn client_for(target: &Target, timeout: Duration) -> Result<reqwest::Client, ServerErrorKind> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if target.host.parse::<IpAddr>().is_err() {
        // Connect to the addresses the policy checked, not to a second DNS answer.
        builder = builder.resolve_to_addrs(&target.host, &target.addrs);
    }
    builder.build().map_err(|_| ServerErrorKind::Other)
}

fn transport_error(error: reqwest::Error) -> ServerErrorKind {
    if error.is_timeout() {
        ServerErrorKind::Timeout
    } else {
        ServerErrorKind::Network
    }
}

async fn read_capped(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>, ServerErrorKind> {
    if response.content_length().is_some_and(|length| length as usize > cap) {
        return Err(ServerErrorKind::BadAudio);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if body.len() + chunk.len() > cap {
            return Err(ServerErrorKind::BadAudio);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn send(
    request: reqwest::RequestBuilder,
    key: Option<&str>,
    cap: usize,
) -> Result<Vec<u8>, ServerErrorKind> {
    let request = match key {
        Some(key) => request.bearer_auth(key),
        None => request,
    };
    let response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(classify_status(status.as_u16()));
    }
    read_capped(response, cap).await
}

async fn get(target: &Target, path: &str, key: Option<&str>, timeout: Duration, cap: usize) -> Result<Vec<u8>, ServerErrorKind> {
    let client = client_for(target, timeout)?;
    send(client.get(netpolicy::endpoint(&target.url, path)), key, cap).await
}

async fn target_of(server: &VoiceServer) -> Result<Target, ServerErrorKind> {
    netpolicy::resolve(&netpolicy::parse_base(&server.base_url)?).await
}

/// One chunk of speech, decoded.
pub async fn synthesize(
    server: &VoiceServer,
    key: Option<&str>,
    voice: Option<&str>,
    text: &str,
    rate: f32,
) -> Result<Pcm, ServerErrorKind> {
    let target = target_of(server).await?;
    let request = adapter::speech_request(server.kind, server.model.as_deref(), voice, text, rate);
    let client = client_for(&target, SPEECH_TIMEOUT)?;
    let body = send(
        client.post(netpolicy::endpoint(&target.url, request.path)).json(&request.body),
        key,
        MAX_SPEECH_BYTES,
    )
    .await?;
    tts_cloud::decode_audio(&body).map_err(|_| ServerErrorKind::BadAudio)
}

/// The voice ids the server lists, from the first known path that answers with any.
pub async fn voices(server: &VoiceServer, key: Option<&str>) -> Result<Vec<String>, ServerErrorKind> {
    let target = target_of(server).await?;
    for path in adapter::voice_paths(server.kind) {
        match get(&target, path, key, PROBE_TIMEOUT, MAX_PROBE_BYTES).await {
            Ok(body) => {
                let found = adapter::parse_voices(&body);
                if !found.is_empty() {
                    return Ok(found);
                }
            }
            Err(ServerErrorKind::BadRequest | ServerErrorKind::Other | ServerErrorKind::BadAudio) => {}
            Err(kind) => return Err(kind),
        }
    }
    Ok(Vec::new())
}

/// Ok when one of the kind's health paths answers 2xx; a server that answers only 404s is of
/// another kind.
pub async fn health(server: &VoiceServer, key: Option<&str>) -> Result<(), ServerErrorKind> {
    let target = target_of(server).await?;
    for path in adapter::health_paths(server.kind) {
        match get(&target, path, key, PROBE_TIMEOUT, MAX_PROBE_BYTES).await {
            Ok(_) => return Ok(()),
            Err(ServerErrorKind::BadRequest) => {}
            Err(kind) => return Err(kind),
        }
    }
    Err(ServerErrorKind::BadRequest)
}
```

Remove the now-unused `use serde_json::Value;` and `ServerKind` imports from the top if the compiler flags them (the tests import what they need through `super::*`; keep `Value` only if a test uses it — `speech_is_posted_and_wav_is_decoded` does, so keep it under `#[cfg(test)]` by moving `use serde_json::Value;` into the tests module).

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test voice_servers::client`
Expected: PASS. (`closed_port_is_network` relies on port 9 being closed on loopback; it is on standard macOS/Windows/Linux setups.)

- [ ] **Step 5: Implement the active-profile helpers in `mod.rs`**

Add `pub mod client;` and `pub mod commands;` to `voice_servers/mod.rs`, then:

```rust
use std::path::PathBuf;

use tauri::AppHandle;

use self::error::ServerErrorKind;
use self::store::VoiceServer;

/// The active profile id and its data folder, where `voice-servers.json` lives.
pub fn active_dir(app: &AppHandle) -> Result<(String, PathBuf), String> {
    let profile = crate::profiles::ensure_profiles_index(app)?.active_profile_id;
    let dir = crate::profiles::profile_data_dir_for_id(app, &profile)?;
    Ok((profile, dir))
}

pub fn find_active(app: &AppHandle, id: &str) -> Option<VoiceServer> {
    let id = id::ServerId::parse(id)?;
    let (_, dir) = active_dir(app).ok()?;
    store::load(&dir).into_iter().find(|server| server.id == id)
}

/// The server's key, read only when it has one (a keychain read can prompt).
pub async fn server_key(app: &AppHandle, server: &VoiceServer) -> Result<Option<String>, ServerErrorKind> {
    if !server.has_key {
        return Ok(None);
    }
    crate::voice_providers::keys::read_secret_async(app, crate::secure_store::SecretKind::VoiceServerKey(server.id))
        .await
        .map_err(|_| ServerErrorKind::Other)
}

/// The voices of a saved server; empty when it is unknown, unreachable or lists none.
pub async fn voices_for(app: &AppHandle, id: &str) -> Vec<String> {
    let Some(server) = find_active(app, id) else {
        return Vec::new();
    };
    let Ok(key) = server_key(app, &server).await else {
        return Vec::new();
    };
    client::voices(&server, key.as_deref()).await.unwrap_or_default()
}
```

`profiles::ensure_profiles_index` must be `pub` (it is used by `voice_providers::keys`); `profile_data_dir_for_id` is `pub`. If the compiler says `ensure_profiles_index` is private, make it `pub(crate)`.

- [ ] **Step 6: Implement the commands**

`src-tauri/src/voice_servers/commands.rs`:

```rust
//! Tauri commands for the local voice server list. Store changes run under one lock so two saves
//! never interleave their read-modify-write.

use serde::Serialize;
use tauri::AppHandle;

use super::error::ServerErrorKind;
use super::id::ServerId;
use super::store::{self, ServerInput, VoiceServer};
use super::{active_dir, client, netpolicy, server_key};
use crate::secure_store::SecretKind;
use crate::voice_providers::keys;

static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedServer {
    pub server: VoiceServer,
    pub loopback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTest {
    pub ok: bool,
    pub reason: Option<ServerErrorKind>,
    pub voices: Vec<String>,
    pub loopback: bool,
}

#[tauri::command]
pub fn voice_servers_list(app: AppHandle) -> Result<Vec<VoiceServer>, String> {
    let (_, dir) = active_dir(&app)?;
    Ok(store::load(&dir))
}

/// Saves a server. `key`: absent keeps the current key, `""` removes it, anything else replaces it.
#[tauri::command]
pub async fn voice_servers_save(
    app: AppHandle,
    input: ServerInput,
    key: Option<String>,
) -> Result<SavedServer, String> {
    let key = match key.as_deref().map(str::trim) {
        None => None,
        Some("") => Some(None),
        Some(raw) => Some(Some(
            keys::validate_key(raw).map_err(|_| "voice_server_invalidKey".to_string())?,
        )),
    };
    let _guard = STORE_LOCK.lock().await;
    let (_, dir) = active_dir(&app)?;
    let mut servers = store::load(&dir);
    let mut server = store::upsert(&mut servers, input)?;
    let url = netpolicy::parse_base(&server.base_url).map_err(|kind| kind.to_string())?;
    let target = netpolicy::resolve(&url).await.map_err(|kind| kind.to_string())?;
    let kind = SecretKind::VoiceServerKey(server.id);
    match key {
        None => {}
        Some(None) => {
            keys::delete_secret_async(&app, kind).await?;
            server.has_key = false;
        }
        Some(Some(value)) => {
            keys::write_secret_async(&app, kind, value).await?;
            server.has_key = true;
        }
    }
    if let Some(entry) = servers.iter_mut().find(|entry| entry.id == server.id) {
        entry.has_key = server.has_key;
    }
    store::save(&dir, &servers)?;
    Ok(SavedServer { server, loopback: target.loopback })
}

#[tauri::command]
pub async fn voice_servers_delete(app: AppHandle, id: String) -> Result<(), String> {
    let id = ServerId::parse(&id).ok_or_else(|| ServerErrorKind::Missing.to_string())?;
    let _guard = STORE_LOCK.lock().await;
    let (_, dir) = active_dir(&app)?;
    let mut servers = store::load(&dir);
    if let Some(server) = servers.iter().find(|server| server.id == id) {
        if server.has_key {
            keys::delete_secret_async(&app, SecretKind::VoiceServerKey(id)).await?;
        }
    }
    if store::remove(&mut servers, id) {
        store::save(&dir, &servers)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_servers_test(app: AppHandle, id: String) -> Result<ServerTest, String> {
    let failed = |reason, loopback| ServerTest { ok: false, reason: Some(reason), voices: Vec::new(), loopback };
    let Some(server) = super::find_active(&app, &id) else {
        return Ok(failed(ServerErrorKind::Missing, true));
    };
    let loopback = match netpolicy::parse_base(&server.base_url) {
        Ok(url) => match netpolicy::resolve(&url).await {
            Ok(target) => target.loopback,
            Err(kind) => return Ok(failed(kind, true)),
        },
        Err(kind) => return Ok(failed(kind, true)),
    };
    let key = match server_key(&app, &server).await {
        Ok(key) => key,
        Err(kind) => return Ok(failed(kind, loopback)),
    };
    if let Err(kind) = client::health(&server, key.as_deref()).await {
        return Ok(failed(kind, loopback));
    }
    let voices = client::voices(&server, key.as_deref()).await.unwrap_or_default();
    Ok(ServerTest { ok: true, reason: None, voices, loopback })
}
```

`keys::validate_key` is `pub(crate)` already.

- [ ] **Step 7: Register the commands**

In `src-tauri/src/lib.rs`, in `invoke_handler`, right after `voice_providers::openrouter::voice_openrouter_models,` add:

```rust
            voice_servers::commands::voice_servers_list,
            voice_servers::commands::voice_servers_save,
            voice_servers::commands::voice_servers_delete,
            voice_servers::commands::voice_servers_test,
```

- [ ] **Step 8: Build and run every voice server test**

Run: `cd src-tauri && cargo test voice_servers:: && cargo clippy --all-targets -- -D warnings`
Expected: tests PASS; clippy clean for the new files.

- [ ] **Step 9: Checkpoint (no commit)**

---

### Task 6: Narration through a server (`tts.rs`)

**Files:**
- Modify: `src-tauri/src/tts.rs` (`TtsProvider`, `tts_speak`, `speak_server`, `fall_back_server`, `tts_voices`)

**Interfaces:**
- Consumes: `voice_servers::{find_active, server_key, voices_for}`, `client::synthesize`, `adapter::playback_rate`, `ServerErrorKind` (Tasks 1–5).
- Produces: `tts_speak(…, server: Option<String>)`, `tts_voices(…, server: Option<String>)`; event `voice://fallback` with `{ usage: "narration", provider: "server", server, reason, fallback: "system" }`.

Re-read `tts.rs` first: another session added `tts_prefetch` and `split_for_speech` today; keep their code untouched.

- [ ] **Step 1: Write the failing tests**

In the `tts.rs` `mod tests`, add `TtsProvider` to the `use super::{…}` list, then:

```rust
    #[test]
    fn server_is_a_provider_without_a_cloud() {
        let provider: TtsProvider = serde_json::from_str("\"server\"").unwrap();
        assert_eq!(provider, TtsProvider::Server);
        assert!(provider.cloud().is_none());
    }

    #[test]
    fn missing_server_reads_as_missing() {
        assert_eq!(
            super::server_or_missing(None),
            Err(crate::voice_servers::error::ServerErrorKind::Missing)
        );
    }
```

Run: `cd src-tauri && cargo test tts::tests` — Expected: compile errors (`TtsProvider::Server`, `server_or_missing`).

- [ ] **Step 2: Add the provider variant**

In `enum TtsProvider` add `Server,` after `Local,`. In `fn cloud`, change the `None` arm to `Self::System | Self::Local | Self::Server => None,`.

- [ ] **Step 3: Add `speak_server` and its fallback**

Below `fn local_failure_log` / `speak_local` (anywhere after `LOCAL_CHUNK_CHARS` is defined), add:

```rust
use crate::voice_servers::error::ServerErrorKind;
use crate::voice_servers::store::VoiceServer;

fn server_or_missing(server: Option<VoiceServer>) -> Result<VoiceServer, ServerErrorKind> {
    server.ok_or(ServerErrorKind::Missing)
}

/// Reports a local server failure and, when nothing has played yet, speaks the whole text with the
/// system voice under the same id. Logs and events carry the server id and error kind only.
async fn fall_back_server(app: AppHandle, id: u64, server: String, kind: ServerErrorKind, text: String, rate: f32) {
    if !is_current(id) {
        return;
    }
    let _ = crate::diagnostics::append_spawn_log(&app, &format!("voice tts: server {server} failed: {kind:?}"));
    let _ = app.emit(
        "voice://fallback",
        serde_json::json!({ "usage": "narration", "provider": "server", "server": server, "reason": kind, "fallback": "system" }),
    );
    let _ = speak_system(app, text, None, Some(rate), id).await;
}

/// A local voice server, chunk by chunk (short chunks: a CPU-only server is slow). A failure
/// before audio plays hands the text to the system voice; a later one stops where it is.
async fn speak_server(app: AppHandle, id: u64, server_id: String, voice: Option<String>, rate: f32, text: String) {
    let server = match server_or_missing(crate::voice_servers::find_active(&app, &server_id)) {
        Ok(server) => server,
        Err(kind) => return fall_back_server(app, id, server_id, kind, text, rate).await,
    };
    let key = match crate::voice_servers::server_key(&app, &server).await {
        Ok(key) => key,
        Err(kind) => return fall_back_server(app, id, server_id, kind, text, rate).await,
    };
    let Ok(out) = player(&app) else {
        return fall_back_server(app, id, server_id, ServerErrorKind::Other, text, rate).await;
    };
    if !is_current(id) {
        return;
    }
    out.begin(id);
    let mut started = false;
    for (start, chunk) in tts_cloud::split_for_tts_spans(&text, LOCAL_CHUNK_CHARS) {
        if !is_current(id) {
            return;
        }
        match crate::voice_servers::client::synthesize(&server, key.as_deref(), voice.as_deref(), &chunk, rate).await {
            Ok(pcm) => {
                let pcm = tts_cloud::trim_silence(pcm);
                let playback = crate::voice_servers::adapter::playback_rate(server.kind, rate, pcm.sample_rate);
                out.push(id, &pcm.samples, playback, span_of(start, &chunk));
                if !started {
                    started = true;
                    emit_start(&app, id);
                    report_progress(app.clone(), Arc::clone(&out), id);
                }
            }
            Err(kind) if !started => return fall_back_server(app, id, server_id, kind, text, rate).await,
            Err(kind) => {
                let _ = crate::diagnostics::append_spawn_log(
                    &app,
                    &format!("voice tts: server {server_id} chunk failed: {kind:?}"),
                );
                break;
            }
        }
    }
    out.close(id);
}
```

Move the two `use` lines to the top `use` block of the file.

- [ ] **Step 4: Route `tts_speak`**

Add the parameter `server: Option<String>,` after `model: Option<String>,` in `tts_speak`. Right before `let Some(cloud) = provider.cloud() else {`, add:

```rust
    if provider == TtsProvider::Server {
        stop_all(&app).await;
        let rate = normalized_rate(rate);
        let server = server.unwrap_or_default();
        tauri::async_runtime::spawn(speak_server(app, id, server, voice, rate, text));
        return Ok(id);
    }
```

- [ ] **Step 5: Route `tts_voices`**

Add `server: Option<String>,` after `model: Option<String>,` in `tts_voices`. As the first statement of the body:

```rust
    if provider == Some(TtsProvider::Server) {
        let ids = crate::voice_servers::voices_for(&app, server.as_deref().unwrap_or_default()).await;
        return Ok(router_voices(ids));
    }
```

(`router_voices` already turns bare ids into `TtsVoice { id, name: id, language: "" }`; update its doc comment to "OpenRouter and local server voices carry no name or language of their own: the id is shown as is.")

- [ ] **Step 6: Run the tests and the full Rust suite**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 7: Checkpoint (no commit)**

---

### Task 7: Frontend types, preferences and Tauri wrappers

**Files:**
- Modify: `src/lib/types.ts` (`TtsProviderId`, `TtsChoice`, new `VoiceServer*` types)
- Modify: `src/lib/voice/providers.ts` (`TTS_PROVIDERS`, `DEFAULT_TTS_CHOICE`)
- Modify: `src/lib/voice/voicePreferences.ts` (`normalizeTtsChoice`)
- Modify: `src/lib/voice/voicePreferences.test.ts`
- Modify: `src/lib/tauri/tts.ts` (`ttsSpeak`, `ttsVoices`)
- Create: `src/lib/tauri/voiceServers.ts`, `src/lib/tauri/voiceServers.test.ts`
- Modify: `src/lib/tauri/index.ts` (`export * from './voiceServers'`)
- Modify: `src/lib/tauri/speech.ts` (`VoiceFallbackEvent`)
- Create: `src/stores/voiceServersStore.ts`, `src/stores/voiceServersStore.test.ts`
- Create: `src/lib/voice/serverErrors.ts`, `src/lib/voice/serverErrors.test.ts`

**Interfaces:**
- Consumes: Rust commands from Task 5, `tts_speak`/`tts_voices` `server` parameter from Task 6.
- Produces:
  - Types: `VoiceServerKind = 'openai' | 'fish'`; `VoiceServer = { id: string; name: string; kind: VoiceServerKind; baseUrl: string; model: string | null; hasKey: boolean }`; `VoiceServerErrorKind = 'policy' | 'network' | 'timeout' | 'auth' | 'badRequest' | 'badAudio' | 'missing' | 'other'`; `TtsProviderId` includes `'server'`; `TtsChoice.server?: string | null`.
  - Wrappers: `voiceServersList(): Promise<VoiceServer[]>`, `voiceServersSave(input: VoiceServerInput, key?: string | null): Promise<{ server: VoiceServer; loopback: boolean }>`, `voiceServersDelete(id: string): Promise<void>`, `voiceServersTest(id: string): Promise<VoiceServerTest>`; `ttsVoices(provider?, model?, server?)`.
  - Store: `useVoiceServersStore` with `servers: VoiceServer[]`, `loaded: boolean`, `health: Record<string, 'connected' | 'disconnected' | 'invalid'>`, `refresh(): Promise<void>`, `setHealth(id, status)`.
  - `serverErrorKey(error: unknown): MessageKey` and `SERVER_ERROR_CODES` in `src/lib/voice/serverErrors.ts`.

- [ ] **Step 1: Write the failing preference tests**

In `src/lib/voice/voicePreferences.test.ts` add (reuse its existing imports of `normalizeVoicePreferences`):

```ts
describe('server narration choice', () => {
  it('keeps a server choice with its server id', () => {
    const prefs = normalizeVoicePreferences({
      voiceTts: { provider: 'server', model: 'x', voice: 'pt-ref', rate: 1.25, server: 'V1StGXR8_Z5jdHi6B-myT' },
    })
    expect(prefs.voiceTts).toEqual({
      provider: 'server',
      model: '',
      voice: 'pt-ref',
      rate: 1.25,
      server: 'V1StGXR8_Z5jdHi6B-myT',
    })
  })

  it('drops a server choice without a server id to the default', () => {
    const prefs = normalizeVoicePreferences({
      voiceTts: { provider: 'server', model: '', voice: null, rate: 1 },
    })
    expect(prefs.voiceTts.provider).toBe('system')
    expect(prefs.voiceTts.server ?? null).toBeNull()
  })

  it('clears a stray server id on other providers', () => {
    const prefs = normalizeVoicePreferences({
      voiceTts: { provider: 'system', model: '', voice: null, rate: 1, server: 'V1StGXR8_Z5jdHi6B-myT' },
    })
    expect(prefs.voiceTts.server).toBeNull()
  })
})
```

Run: `npx vitest run src/lib/voice/voicePreferences.test.ts` — Expected: FAIL (server provider normalized to system).

- [ ] **Step 2: Types and provider list**

`src/lib/types.ts` — change and add near `TtsChoice`:

```ts
export type TtsProviderId = 'system' | 'local' | 'server' | CloudVoiceProviderId
export interface TtsChoice {
  provider: TtsProviderId
  model: string
  voice: string | null
  rate: number
  /** The local voice server's id; set only when `provider` is `'server'`. */
  server?: string | null
}
export type VoiceServerKind = 'openai' | 'fish'
export interface VoiceServer {
  id: string
  name: string
  kind: VoiceServerKind
  baseUrl: string
  model: string | null
  hasKey: boolean
}
export type VoiceServerErrorKind =
  | 'policy'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'badRequest'
  | 'badAudio'
  | 'missing'
  | 'other'
```

`src/lib/voice/providers.ts`:

```ts
export const TTS_PROVIDERS: readonly TtsProviderId[] = [
  'system',
  'local',
  'server',
  ...CLOUD_VOICE_PROVIDERS,
]
export const DEFAULT_TTS_CHOICE: TtsChoice = {
  provider: 'system',
  model: '',
  voice: null,
  rate: 1,
  server: null,
}
```

- [ ] **Step 3: Normalize the server choice**

In `normalizeTtsChoice` (`src/lib/voice/voicePreferences.ts`):

```ts
  const { provider, model, voice, rate, server } = value as Record<string, unknown>
  if (typeof provider !== 'string' || !(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    return DEFAULT_TTS_CHOICE
  }
  if (!usable(provider, flags)) return DEFAULT_TTS_CHOICE
  if (provider === 'server') {
    const serverId = text(server)
    if (!serverId) return DEFAULT_TTS_CHOICE
    return {
      provider,
      model: '',
      voice: text(voice),
      rate: clampRate(rate, DEFAULT_TTS_CHOICE.rate),
      server: serverId,
    }
  }
  const id = text(model) ?? ''
  if (provider !== 'system' && !id) return DEFAULT_TTS_CHOICE
  return {
    provider: provider as TtsProviderId,
    model: provider === 'system' ? '' : id,
    voice: text(voice),
    rate: clampRate(rate, DEFAULT_TTS_CHOICE.rate),
    server: null,
  }
```

Run: `npx vitest run src/lib/voice/voicePreferences.test.ts` — Expected: PASS (fix any older assertion in this file that compares a whole `voiceTts` object with `toEqual` by adding `server: null` to its expected value).

- [ ] **Step 4: TTS wrappers carry the server**

`src/lib/tauri/tts.ts`:

```ts
export function ttsSpeak(text: string, choice: TtsChoice): Promise<number> {
  return invoke<number>('tts_speak', {
    text,
    voice: choice.voice,
    rate: choice.rate,
    provider: choice.provider,
    model: choice.model || null,
    server: choice.server ?? null,
  })
}
```

```ts
/** Voices of a provider; OpenRouter lists the voices of `model`, a local server those of `server`. */
export function ttsVoices(
  provider?: TtsProviderId,
  model?: string,
  server?: string | null,
): Promise<TtsVoice[]> {
  return invoke<TtsVoice[]>('tts_voices', {
    provider: provider ?? null,
    model: model || null,
    server: server ?? null,
  })
}
```

In `src/lib/tauri/speech.ts`, widen the fallback event:

```ts
export type VoiceFallbackEvent = {
  usage: string
  provider: CloudVoiceProviderId | 'system' | 'server'
  reason: CloudErrorKind | VoiceServerErrorKind
  fallback: string
  /** The local server's id, on `provider: 'server'`. */
  server?: string
}
```

(import `VoiceServerErrorKind` from `../types`).

- [ ] **Step 5: Write the failing wrapper test**

`src/lib/tauri/voiceServers.test.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { voiceServersDelete, voiceServersSave, voiceServersTest } from './voiceServers'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('voice server wrappers', () => {
  beforeEach(() => vi.mocked(invoke).mockReset().mockResolvedValue(undefined))

  it('saves with no key change by default and removes the key with an empty string', async () => {
    const input = { name: 'A', kind: 'openai' as const, baseUrl: 'http://localhost:4123', model: null }
    await voiceServersSave(input)
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_save', { input, key: null })
    await voiceServersSave(input, '')
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_save', { input, key: '' })
  })

  it('tests and deletes by id', async () => {
    await voiceServersTest('id1')
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_test', { id: 'id1' })
    await voiceServersDelete('id1')
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_delete', { id: 'id1' })
  })
})
```

Run: `npx vitest run src/lib/tauri/voiceServers.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 6: Implement the wrappers**

`src/lib/tauri/voiceServers.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

import type { VoiceServer, VoiceServerErrorKind, VoiceServerKind } from '../types'

export type VoiceServerInput = {
  /** Absent creates a server. */
  id?: string
  name: string
  kind: VoiceServerKind
  baseUrl: string
  model: string | null
}
export type VoiceServerSaved = { server: VoiceServer; loopback: boolean }
export type VoiceServerTest = {
  ok: boolean
  reason: VoiceServerErrorKind | null
  voices: string[]
  loopback: boolean
}

export function voiceServersList(): Promise<VoiceServer[]> {
  return invoke('voice_servers_list')
}

/** `key`: absent or null keeps the saved key, `''` removes it, anything else replaces it. */
export function voiceServersSave(
  input: VoiceServerInput,
  key?: string | null,
): Promise<VoiceServerSaved> {
  return invoke('voice_servers_save', { input, key: key ?? null })
}

export async function voiceServersDelete(id: string): Promise<void> {
  await invoke('voice_servers_delete', { id })
}

export function voiceServersTest(id: string): Promise<VoiceServerTest> {
  return invoke('voice_servers_test', { id })
}
```

Add `export * from './voiceServers'` to `src/lib/tauri/index.ts` next to `export * from './voiceProviders'`.

Run: `npx vitest run src/lib/tauri/voiceServers.test.ts` — Expected: PASS.

- [ ] **Step 7: Write the failing error-key test**

`src/lib/voice/serverErrors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { serverErrorKey } from './serverErrors'

describe('serverErrorKey', () => {
  it('maps backend codes to messages', () => {
    expect(serverErrorKey('voice_server_policy')).toBe('prefs.voiceServerError.policy')
    expect(serverErrorKey(new Error('voice_server_invalidName'))).toBe(
      'prefs.voiceServerError.invalidName',
    )
    expect(serverErrorKey('network')).toBe('prefs.voiceServerError.network')
  })

  it('reads anything unknown as other', () => {
    expect(serverErrorKey('boom')).toBe('prefs.voiceServerError.other')
    expect(serverErrorKey(undefined)).toBe('prefs.voiceServerError.other')
  })
})
```

Run: `npx vitest run src/lib/voice/serverErrors.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 8: Implement `serverErrors.ts` and its i18n keys**

`src/lib/voice/serverErrors.ts`:

```ts
import type { MessageKey } from '../i18n/messages/en'

export const SERVER_ERROR_CODES = [
  'policy',
  'network',
  'timeout',
  'auth',
  'badRequest',
  'badAudio',
  'missing',
  'invalidName',
  'invalidModel',
  'invalidKey',
  'limit',
  'other',
] as const
type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number]

/** The message for a backend `voice_server_*` code (or a bare kind); unknown reads as `other`. */
export function serverErrorKey(error: unknown): MessageKey {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = raw.replace(/^voice_server_/, '')
  const known = (SERVER_ERROR_CODES as readonly string[]).includes(code)
  return `prefs.voiceServerError.${(known ? code : 'other') as ServerErrorCode}`
}
```

Add these keys to `src/lib/i18n/messages/en.ts` (next to the other `prefs.voice*` keys), and the same keys to `pt-BR.ts` and `zh-CN.ts` with the translations shown:

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceServerError.policy` | Only addresses on this computer or your local network are allowed. | Só são aceitos endereços deste computador ou da sua rede local. | 只允许本机或局域网内的地址。 |
| `prefs.voiceServerError.network` | Could not reach the server. Is it running? | Não foi possível acessar o servidor. Ele está rodando? | 无法连接到服务器。它在运行吗？ |
| `prefs.voiceServerError.timeout` | The server took too long to answer. | O servidor demorou demais para responder. | 服务器响应超时。 |
| `prefs.voiceServerError.auth` | The server rejected the key. | O servidor recusou a chave. | 服务器拒绝了该密钥。 |
| `prefs.voiceServerError.badRequest` | The server refused the request. Check the kind, model and voice. | O servidor recusou o pedido. Confira o tipo, o modelo e a voz. | 服务器拒绝了请求。请检查类型、模型和语音。 |
| `prefs.voiceServerError.badAudio` | The server returned audio Alethe cannot play. | O servidor devolveu um áudio que o Alethe não consegue tocar. | 服务器返回了 Alethe 无法播放的音频。 |
| `prefs.voiceServerError.missing` | This server was removed. | Este servidor foi removido. | 该服务器已被移除。 |
| `prefs.voiceServerError.invalidName` | Give the server a name of up to 64 characters. | Dê ao servidor um nome de até 64 caracteres. | 请为服务器命名（最多 64 个字符）。 |
| `prefs.voiceServerError.invalidModel` | The model name is too long. | O nome do modelo é longo demais. | 模型名称过长。 |
| `prefs.voiceServerError.invalidKey` | The key has an invalid format. | A chave tem um formato inválido. | 密钥格式无效。 |
| `prefs.voiceServerError.limit` | You can save up to 32 servers. | Você pode salvar até 32 servidores. | 最多可保存 32 个服务器。 |
| `prefs.voiceServerError.other` | The server returned an error. | O servidor devolveu um erro. | 服务器返回了错误。 |

Run: `npx vitest run src/lib/voice/serverErrors.test.ts` — Expected: PASS.

- [ ] **Step 9: Write the failing store test**

`src/stores/voiceServersStore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ voiceServersList: vi.fn() }))
vi.mock('../lib/tauri', () => tauri)

import { useVoiceServersStore } from './voiceServersStore'

const server = {
  id: 'V1StGXR8_Z5jdHi6B-myT',
  name: 'Chatterbox',
  kind: 'openai' as const,
  baseUrl: 'http://localhost:4123',
  model: null,
  hasKey: false,
}

describe('voiceServersStore', () => {
  beforeEach(() => {
    useVoiceServersStore.setState({ servers: [], loaded: false, health: {} })
    tauri.voiceServersList.mockReset()
  })

  it('loads the list and keeps health for servers that still exist', async () => {
    useVoiceServersStore.setState({ health: { [server.id]: 'connected', gone: 'invalid' } })
    tauri.voiceServersList.mockResolvedValue([server])
    await useVoiceServersStore.getState().refresh()
    const state = useVoiceServersStore.getState()
    expect(state.servers).toEqual([server])
    expect(state.loaded).toBe(true)
    expect(state.health).toEqual({ [server.id]: 'connected' })
  })

  it('marks the list loaded even when listing fails', async () => {
    tauri.voiceServersList.mockRejectedValue(new Error('x'))
    await useVoiceServersStore.getState().refresh()
    expect(useVoiceServersStore.getState()).toMatchObject({ servers: [], loaded: true })
  })
})
```

Run: `npx vitest run src/stores/voiceServersStore.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 10: Implement the store**

`src/stores/voiceServersStore.ts`:

```ts
import { create } from 'zustand'

import { voiceServersList } from '../lib/tauri'
import type { VoiceServer } from '../lib/types'

type ServerHealth = 'connected' | 'disconnected' | 'invalid'

type VoiceServersState = {
  servers: VoiceServer[]
  loaded: boolean
  /** Last connection test per server in this session. */
  health: Record<string, ServerHealth>
  refresh: () => Promise<void>
  setHealth: (id: string, status: ServerHealth) => void
}

/** The active profile's local voice servers, read from the backend (which owns the list). */
export const useVoiceServersStore = create<VoiceServersState>((set) => ({
  servers: [],
  loaded: false,
  health: {},
  refresh: async () => {
    try {
      const servers = await voiceServersList()
      set((state) => ({
        servers,
        loaded: true,
        health: Object.fromEntries(
          Object.entries(state.health).filter(([id]) => servers.some((s) => s.id === id)),
        ),
      }))
    } catch {
      set({ loaded: true })
    }
  },
  setHealth: (id, status) => set((state) => ({ health: { ...state.health, [id]: status } })),
}))
```

Run: `npx vitest run src/stores/voiceServersStore.test.ts src/lib` — Expected: PASS.

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: errors only where `PROVIDER_META[...]` is indexed by a `TtsProviderId` (`VoiceInUseSummary.tsx`, `useVoiceFallbackToasts.ts`); Task 8 fixes those. Any other error: fix it here (for example a `TtsChoice` literal that now needs `server: null` in a `toEqual`).

- [ ] **Step 12: Checkpoint (no commit)**

---

### Task 8: Provider metadata, fallback toast and in-use warnings

**Files:**
- Modify: `src/components/modals/preferences/voice/providerMeta.ts`
- Modify: `src/hooks/useVoiceFallbackToasts.ts`
- Modify: `src/components/modals/preferences/voice/inUseWarnings.ts` (+ its test if one exists, else create `inUseWarnings.test.ts`)
- Modify: `src/components/modals/preferences/voice/VoiceInUseSummary.tsx`
- Modify: `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: `useVoiceServersStore` (Task 7), `serverErrorKey` (Task 7).
- Produces: `PROVIDER_META.server` (`group: 'server'`), `VoiceProviderId` includes `'server'`; `inUseWarnings(prefs, downloads, appleStatusOf?, servers?)` where `servers?: { id: string }[] | null` (null = not loaded yet).

- [ ] **Step 1: Write the failing warning test**

Add to (or create) `src/components/modals/preferences/voice/inUseWarnings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_STT_CHOICE } from '../../../../lib/voice/providers'
import { inUseWarnings } from './inUseWarnings'

const downloads = { models: [], statusOf: () => ({ kind: 'idle' }) as never }
const prefs = (server: string) => ({
  voiceStt: { dictation: DEFAULT_STT_CHOICE, conversation: DEFAULT_STT_CHOICE },
  voiceTts: { provider: 'server' as const, model: '', voice: null, rate: 1, server },
  voiceProviders: {},
})

describe('server narration warnings', () => {
  it('warns when the chosen server is gone', () => {
    expect(inUseWarnings(prefs('gone'), downloads, undefined, [{ id: 'other' }]).narration).toBe(
      'prefs.voiceServerRemoved',
    )
  })

  it('stays quiet while the list loads and when the server exists', () => {
    expect(inUseWarnings(prefs('a'), downloads, undefined, null).narration).toBeNull()
    expect(inUseWarnings(prefs('a'), downloads, undefined, [{ id: 'a' }]).narration).toBeNull()
  })
})
```

Run: `npx vitest run src/components/modals/preferences/voice/inUseWarnings.test.ts` — Expected: FAIL (`narration` is null for the gone server).

- [ ] **Step 2: Add the warning**

In `inUseWarnings.ts`, extend the signature and the narration row:

```ts
export function inUseWarnings(
  prefs: VoicePrefs,
  downloads: DownloadsView,
  appleStatusOf: AppleStatusOf = () => undefined,
  /** Saved local servers; null until the list loads. */
  servers: { id: string }[] | null = null,
): Record<VoiceTabUse, MessageKey | null> {
```

```ts
  const narration = (): MessageKey | null => {
    const choice = prefs.voiceTts
    if (choice.provider === 'server') {
      if (servers === null) return null
      return servers.some((server) => server.id === choice.server)
        ? null
        : 'prefs.voiceServerRemoved'
    }
    return providerWarning(choice.provider, choice.model, prefs, downloads)
  }
  return {
    dictation: stt('dictation'),
    conversation: stt('conversation'),
    narration: narration(),
  }
```

- [ ] **Step 3: Provider metadata**

In `providerMeta.ts`: import `Server` from `lucide-react`; change `Meta.group` to `'local' | 'cloud' | 'server'`; change `VoiceProviderId` to `'local' | 'apple' | 'system' | 'server' | CloudVoiceProviderId`; add the entry:

```ts
  server: {
    icon: Server,
    name: 'voice.provider.server',
    description: 'prefs.voiceProviderServerDesc',
    group: 'server',
  },
```

In `ProviderGrid.tsx` `actionOf`, the `PROVIDER_META[id].group === 'local'` branch stays; `'server'` never reaches `ProviderGrid`'s `ids` lists, so nothing else changes there in this task.

- [ ] **Step 4: In-use summary shows the server name**

In `VoiceInUseSummary.tsx`:

```ts
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
```

Inside the component:

```ts
  const servers = useVoiceServersStore((s) => s.servers)
  const serversLoaded = useVoiceServersStore((s) => s.loaded)
  const refreshServers = useVoiceServersStore((s) => s.refresh)
  useEffect(() => {
    if (!serversLoaded) void refreshServers()
  }, [serversLoaded, refreshServers])
```

Pass `serversLoaded ? servers : null` as the fourth argument of `inUseWarnings(...)`. In `detailOf`, before the cloud branch, add:

```ts
    if (provider === 'server') {
      return servers.find((server) => server.id === voiceTts.server)?.name ?? null
    }
```

(`useEffect` must be in the file's `react` import.)

- [ ] **Step 5: Fallback toast for servers**

In `useVoiceFallbackToasts.ts`, replace the body text line with:

```ts
      const reason =
        event.provider === 'server'
          ? t(serverErrorKey(event.reason))
          : t(`prefs.voiceTestFailed.${event.reason}` as MessageKey)
      useUiStore.getState().pushToast({
        title: t('voice.fallback.title', { provider }),
        body: `${reason} ${t('voice.fallback.used', { engine: t(engineKey) })}`,
      })
```

and import `serverErrorKey` from `'../lib/voice/serverErrors'`. `voice.provider.server` (Step 6) makes the title read "Local server".

- [ ] **Step 6: i18n keys**

Add to `en.ts`, `pt-BR.ts`, `zh-CN.ts`:

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `voice.provider.server` | Local server | Servidor local | 本地服务器 |
| `prefs.voiceProviderServerDesc` | A speech server you run on this computer or your local network, such as Chatterbox or Fish Speech. | Um servidor de voz que você roda neste computador ou na rede local, como Chatterbox ou Fish Speech. | 你在本机或局域网运行的语音服务器，例如 Chatterbox 或 Fish Speech。 |
| `prefs.voiceServerRemoved` | Server removed — using the system voice | Servidor removido — usando a voz do sistema | 服务器已移除——正在使用系统语音 |

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run src/components/modals/preferences/voice src/hooks && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 8: Checkpoint (no commit)**

---

### Task 9: Server group in the Voice page and the server detail form

**Files:**
- Create: `src/components/modals/preferences/voice/ServerGroup.tsx`
- Create: `src/components/modals/preferences/voice/ServerDetail.tsx`, `ServerDetail.module.css`, `ServerDetail.test.tsx`
- Modify: `src/components/modals/preferences/voice/ProviderGrid.tsx` (render `ServerGroup` after the local group, new `onOpenServer` prop)
- Modify: `src/components/modals/preferences/voice/VoicePage.tsx` (server detail state)
- Modify: `src/components/modals/preferences/voice/ProviderGrid.test.tsx`, `VoicePage.test.tsx` if they render `ProviderGrid` without the new prop (add `onOpenServer={() => undefined}`)
- Modify: `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: wrappers, store and `serverErrorKey` (Task 7); `PROVIDER_META.server` (Task 8); `withTtsChoice` (existing).
- Produces: `ServerGroup({ onOpen }: { onOpen: (id: string | null) => void })`; `ServerDetail({ serverId, onBack }: { serverId: string | null; onBack: () => void })` (`null` = new server); `ProviderGrid({ onOpen, onOpenServer })`.

- [ ] **Step 1: i18n keys for this task**

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceGroupServers` | Local servers | Servidores locais | 本地服务器 |
| `prefs.voiceServerAdd` | Add server | Adicionar servidor | 添加服务器 |
| `prefs.voiceServerNew` | New server | Novo servidor | 新服务器 |
| `prefs.voiceServerKind` | Kind | Tipo | 类型 |
| `prefs.voiceServerKindOpenai` | OpenAI-compatible | Compatível com OpenAI | 兼容 OpenAI |
| `prefs.voiceServerKindFish` | Fish Speech | Fish Speech | Fish Speech |
| `prefs.voiceServerName` | Name | Nome | 名称 |
| `prefs.voiceServerAddress` | Address | Endereço | 地址 |
| `prefs.voiceServerAddressHint` | For example Chatterbox http://localhost:4123 · Fish Speech http://localhost:8080 · Kokoro-FastAPI http://localhost:8880 | Por exemplo Chatterbox http://localhost:4123 · Fish Speech http://localhost:8080 · Kokoro-FastAPI http://localhost:8880 | 例如 Chatterbox http://localhost:4123 · Fish Speech http://localhost:8080 · Kokoro-FastAPI http://localhost:8880 |
| `prefs.voiceServerModel` | Model (optional) | Modelo (opcional) | 模型（可选） |
| `prefs.voiceServerKey` | Key (optional) | Chave (opcional) | 密钥（可选） |
| `prefs.voiceServerKeyHint` | Stored in the system keychain. Leave empty to keep the current key. | Guardada no chaveiro do sistema. Deixe vazio para manter a chave atual. | 保存在系统钥匙串中。留空则保留当前密钥。 |
| `prefs.voiceServerSave` | Save | Salvar | 保存 |
| `prefs.voiceServerSaved` | Saved. | Salvo. | 已保存。 |
| `prefs.voiceServerTest` | Test connection | Testar conexão | 测试连接 |
| `prefs.voiceServerTesting` | Testing… | Testando… | 正在测试… |
| `prefs.voiceServerOnline` | Online · {count} voices | Online · {count} vozes | 在线 · {count} 个语音 |
| `prefs.voiceServerRemoveKey` | Remove key | Remover chave | 移除密钥 |
| `prefs.voiceServerRemove` | Remove server | Remover servidor | 移除服务器 |
| `prefs.voiceServerUse` | Use for narration | Usar na narração | 用于朗读 |
| `prefs.voiceServerLanNotice` | This server is on your local network: narrated text crosses it, unencrypted over http. | Este servidor está na sua rede local: o texto narrado passa por ela, sem criptografia em http. | 该服务器位于局域网：朗读文本会经过网络，使用 http 时不加密。 |

- [ ] **Step 2: Write the failing detail test**

`src/components/modals/preferences/voice/ServerDetail.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import { ServerDetail } from './ServerDetail'

const tauri = vi.hoisted(() => ({
  voiceServersList: vi.fn(),
  voiceServersSave: vi.fn(),
  voiceServersDelete: vi.fn(),
  voiceServersTest: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const saved = {
  id: 'V1StGXR8_Z5jdHi6B-myT',
  name: 'Fish',
  kind: 'fish' as const,
  baseUrl: 'http://192.168.0.5:8080',
  model: null,
  hasKey: false,
}

afterEach(cleanup)

describe('ServerDetail', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    useVoiceServersStore.setState({ servers: [], loaded: true, health: {} })
    Object.values(tauri).forEach((fn) => fn.mockReset())
    tauri.voiceServersList.mockResolvedValue([saved])
    tauri.voiceServersSave.mockResolvedValue({ server: saved, loopback: false })
    tauri.voiceServersTest.mockResolvedValue({ ok: true, reason: null, voices: ['a', 'b'], loopback: false })
  })

  it('creates a server, shows the LAN notice and tests it', async () => {
    const onBack = vi.fn()
    render(<ServerDetail serverId={null} onBack={onBack} />)
    fireEvent.change(screen.getByLabelText('prefs.voiceServerName'), { target: { value: 'Fish' } })
    fireEvent.change(screen.getByLabelText('prefs.voiceServerAddress'), {
      target: { value: 'http://192.168.0.5:8080' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerSave' }))
    await waitFor(() =>
      expect(tauri.voiceServersSave).toHaveBeenCalledWith(
        { name: 'Fish', kind: 'openai', baseUrl: 'http://192.168.0.5:8080', model: null },
        null,
      ),
    )
    expect(await screen.findByText('prefs.voiceServerLanNotice')).toBeTruthy()
    await waitFor(() => expect(tauri.voiceServersTest).toHaveBeenCalledWith(saved.id))
    expect(await screen.findByText('prefs.voiceServerOnline:{"count":2}')).toBeTruthy()
    expect(useVoiceServersStore.getState().health[saved.id]).toBe('connected')
  })

  it('shows a policy error inline', async () => {
    tauri.voiceServersSave.mockRejectedValue('voice_server_policy')
    render(<ServerDetail serverId={null} onBack={() => undefined} />)
    fireEvent.change(screen.getByLabelText('prefs.voiceServerName'), { target: { value: 'X' } })
    fireEvent.change(screen.getByLabelText('prefs.voiceServerAddress'), {
      target: { value: 'http://8.8.8.8' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerSave' }))
    expect(await screen.findByText('prefs.voiceServerError.policy')).toBeTruthy()
  })

  it('uses a saved server for narration and removes it', async () => {
    useVoiceServersStore.setState({ servers: [saved], loaded: true, health: {} })
    const onBack = vi.fn()
    render(<ServerDetail serverId={saved.id} onBack={onBack} />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerUse' }))
    expect(useProjectsStore.getState().preferences.voiceTts).toMatchObject({
      provider: 'server',
      server: saved.id,
      model: '',
      voice: null,
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerRemove' }))
    await waitFor(() => expect(tauri.voiceServersDelete).toHaveBeenCalledWith(saved.id))
    await waitFor(() => expect(onBack).toHaveBeenCalled())
  })
})
```

Run: `npx vitest run src/components/modals/preferences/voice/ServerDetail.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `ServerDetail`**

`src/components/modals/preferences/voice/ServerDetail.tsx`:

```tsx
import { ArrowLeft, PlugZap, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import {
  voiceServersDelete,
  voiceServersSave,
  voiceServersTest,
  type VoiceServerTest,
} from '../../../../lib/tauri'
import type { VoiceServerKind } from '../../../../lib/types'
import { serverErrorKey } from '../../../../lib/voice/serverErrors'
import { withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import { Dropdown } from '../../../ui/Dropdown'
import controls from '../../controls.module.css'
import styles from './ServerDetail.module.css'

type Feedback = { tone: 'ok' | 'error'; text: string } | null

export function ServerDetail({
  serverId,
  onBack,
}: {
  /** null creates a server. */
  serverId: string | null
  onBack: () => void
}) {
  const t = useT()
  const ids = { name: useId(), address: useId(), model: useId(), key: useId() }
  const existing = useVoiceServersStore((s) => s.servers.find((server) => server.id === serverId))
  const refresh = useVoiceServersStore((s) => s.refresh)
  const setHealth = useVoiceServersStore((s) => s.setHealth)
  const [id, setId] = useState<string | null>(serverId)
  const [kind, setKind] = useState<VoiceServerKind>(existing?.kind ?? 'openai')
  const [name, setName] = useState(existing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [model, setModel] = useState(existing?.model ?? '')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(existing?.hasKey ?? false)
  const [lan, setLan] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  const test = async (target: string) => {
    setFeedback({ tone: 'ok', text: t('prefs.voiceServerTesting') })
    let result: VoiceServerTest
    try {
      result = await voiceServersTest(target)
    } catch (error) {
      setFeedback({ tone: 'error', text: t(serverErrorKey(error)) })
      return
    }
    setLan(!result.loopback)
    setHealth(target, result.ok ? 'connected' : result.reason === 'auth' ? 'invalid' : 'disconnected')
    setFeedback(
      result.ok
        ? { tone: 'ok', text: t('prefs.voiceServerOnline', { count: result.voices.length }) }
        : { tone: 'error', text: t(serverErrorKey(result.reason)) },
    )
  }

  const save = async (keyChange: string | null) => {
    setBusy(true)
    setFeedback(null)
    try {
      const saved = await voiceServersSave(
        {
          ...(id ? { id } : {}),
          name: name.trim(),
          kind,
          baseUrl: baseUrl.trim(),
          model: kind === 'openai' && model.trim() ? model.trim() : null,
        },
        keyChange,
      )
      setId(saved.server.id)
      setHasKey(saved.server.hasKey)
      setKey('')
      setLan(!saved.loopback)
      await refresh()
      await test(saved.server.id)
    } catch (error) {
      setFeedback({ tone: 'error', text: t(serverErrorKey(error)) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!id) return
    setBusy(true)
    try {
      await voiceServersDelete(id)
      await refresh()
      onBack()
    } catch (error) {
      setFeedback({ tone: 'error', text: t(serverErrorKey(error)) })
      setBusy(false)
    }
  }

  const use = () => {
    if (!id) return
    const store = useProjectsStore.getState()
    store.setPreferences(
      withTtsChoice(store.preferences, { provider: 'server', server: id, model: '', voice: null }),
    )
  }

  return (
    <div className={styles.root}>
      <nav className={styles.breadcrumb}>
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('prefs.voiceAccountsTitle')}
        </button>
        <span aria-hidden="true">/</span>
        <strong>{existing?.name ?? (name.trim() || t('prefs.voiceServerNew'))}</strong>
      </nav>
      <p className={styles.description}>{t('prefs.voiceProviderServerDesc')}</p>
      <div className={styles.form}>
        <div className={styles.field}>
          <span className={styles.label}>{t('prefs.voiceServerKind')}</span>
          <Dropdown
            value={kind}
            ariaLabel={t('prefs.voiceServerKind')}
            options={[
              { value: 'openai', label: t('prefs.voiceServerKindOpenai') },
              { value: 'fish', label: t('prefs.voiceServerKindFish') },
            ]}
            onChange={(value) => setKind(value as VoiceServerKind)}
          />
        </div>
        {/* The label holds only its text, so a hint never becomes part of the input's name. */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.name}>
            {t('prefs.voiceServerName')}
          </label>
          <input
            id={ids.name}
            className={controls.input}
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.address}>
            {t('prefs.voiceServerAddress')}
          </label>
          <input
            id={ids.address}
            className={controls.input}
            spellCheck={false}
            placeholder="http://localhost:4123"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <small className={styles.hint}>{t('prefs.voiceServerAddressHint')}</small>
        </div>
        {kind === 'openai' ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={ids.model}>
              {t('prefs.voiceServerModel')}
            </label>
            <input
              id={ids.model}
              className={controls.input}
              spellCheck={false}
              placeholder="tts-1"
              maxLength={128}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
        ) : null}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.key}>
            {t('prefs.voiceServerKey')}
          </label>
          <input
            id={ids.key}
            className={controls.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasKey ? '••••••••••••••••' : ''}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <small className={styles.hint}>{t('prefs.voiceServerKeyHint')}</small>
        </div>
      </div>
      {lan ? <p className={styles.notice}>{t('prefs.voiceServerLanNotice')}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnPrimary}`}
          disabled={busy || !name.trim() || !baseUrl.trim()}
          onClick={() => void save(key.trim() ? key.trim() : null)}
        >
          {t('prefs.voiceServerSave')}
        </button>
        <button
          type="button"
          className={`${controls.btn} ${styles.iconButton}`}
          disabled={busy || !id}
          onClick={() => id && void test(id)}
        >
          <PlugZap size={14} aria-hidden="true" />
          {t('prefs.voiceServerTest')}
        </button>
        <button
          type="button"
          className={controls.btn}
          disabled={busy || !id}
          onClick={use}
        >
          {t('prefs.voiceServerUse')}
        </button>
        {hasKey ? (
          <button
            type="button"
            className={controls.btn}
            disabled={busy}
            onClick={() => void save('')}
          >
            {t('prefs.voiceServerRemoveKey')}
          </button>
        ) : null}
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSmDanger} ${styles.iconButton} ${styles.remove}`}
          disabled={busy || !id}
          onClick={() => void remove()}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t('prefs.voiceServerRemove')}
        </button>
      </div>
      {feedback ? (
        <p role="status" className={styles.feedback} data-tone={feedback.tone}>
          {feedback.text}
        </p>
      ) : null}
    </div>
  )
}
```

`src/components/modals/preferences/voice/ServerDetail.module.css` — copy the token usage of `ProviderDetail.module.css` (`.root`, `.breadcrumb`, `.back`, `.description`) and `CloudKeyForm.module.css` (`.form`, `.label`, `.hint`, `.actions`, `.iconButton`, `.remove`, `.feedback` with its `data-tone` rules) into this file, then add:

```css
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.notice {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}
```

Use only variables that `src/styles/theme.css` defines (check `--border` exists there; if the file names it differently, use that name).

Run: `npx vitest run src/components/modals/preferences/voice/ServerDetail.test.tsx` — Expected: PASS.

- [ ] **Step 4: Server group in the grid**

`src/components/modals/preferences/voice/ServerGroup.tsx`:

```tsx
import { Plus } from 'lucide-react'
import { useEffect } from 'react'

import { useT } from '../../../../lib/i18n'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import controls from '../../controls.module.css'
import { ProviderCard } from './ProviderCard'
import { ProviderGroup } from './ProviderGroup'
import { PROVIDER_META } from './providerMeta'

function host(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** The saved local voice servers as provider cards, plus a button to add one. */
export function ServerGroup({ onOpen }: { onOpen: (id: string | null) => void }) {
  const t = useT()
  const servers = useVoiceServersStore((s) => s.servers)
  const loaded = useVoiceServersStore((s) => s.loaded)
  const health = useVoiceServersStore((s) => s.health)
  const refresh = useVoiceServersStore((s) => s.refresh)

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  return (
    <ProviderGroup title={t('prefs.voiceGroupServers')}>
      {servers.map((server) => (
        <ProviderCard
          key={server.id}
          icon={PROVIDER_META.server.icon}
          title={server.name}
          description={`${t(
            server.kind === 'fish' ? 'prefs.voiceServerKindFish' : 'prefs.voiceServerKindOpenai',
          )} · ${host(server.baseUrl)}`}
          status={health[server.id] ?? 'disconnected'}
          actionLabel={t('prefs.voiceActionManage')}
          onAction={() => onOpen(server.id)}
        />
      ))}
      <button type="button" className={controls.btn} onClick={() => onOpen(null)}>
        <Plus size={14} aria-hidden="true" />
        {t('prefs.voiceServerAdd')}
      </button>
    </ProviderGroup>
  )
}
```

In `ProviderGrid.tsx`: add the prop `onOpenServer: (id: string | null) => void` to the component signature; import `Fragment` from `react` and `ServerGroup`; in the groups render, wrap each group so the server group follows the local one:

```tsx
      {groups
        .filter((group) => filter === 'all' || filter === group.id)
        .map((group) => (
          <Fragment key={group.id}>
            <ProviderGroup title={group.title}>
              {/* existing cards, unchanged */}
            </ProviderGroup>
            {group.id === 'local' ? <ServerGroup onOpen={onOpenServer} /> : null}
          </Fragment>
        ))}
```

(Move the existing `key={group.id}` from `ProviderGroup` to `Fragment`.)

- [ ] **Step 5: Route the detail in `VoicePage`**

In `VoicePage.tsx`:

```tsx
import { ServerDetail } from './ServerDetail'
```

Add state next to `detail`:

```tsx
  // undefined: no server open; null: a new server; string: a saved server's id.
  const [serverDetail, setServerDetail] = useState<string | null | undefined>(undefined)
```

In the `useLayoutEffect` that reacts to `target`, also call `setServerDetail(undefined)` where it calls `setDetail(null)`. Before `if (detail) {`, add:

```tsx
  if (serverDetail !== undefined) {
    return (
      <div className={styles.page}>
        <ServerDetail serverId={serverDetail} onBack={() => setServerDetail(undefined)} />
      </div>
    )
  }
```

Change `<ProviderGrid onOpen={openProvider} />` to `<ProviderGrid onOpen={openProvider} onOpenServer={setServerDetail} />`, and pass `onOpenServer={setServerDetail}` down to `NarrationPanel` (Task 10 adds that prop; until then leave this call unchanged and add it in Task 10).

Add `onOpenServer={() => undefined}` wherever `ProviderGrid` is rendered in tests (`ProviderGrid.test.tsx`), and mock `voiceServersList` (resolved `[]`) in `ProviderGrid.test.tsx` and `VoicePage.test.tsx` tauri mocks so the group loads quietly.

- [ ] **Step 6: Run the voice preference tests and typecheck**

Run: `npx vitest run src/components/modals/preferences && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 7: Checkpoint (no commit)**

---

### Task 10: Servers in the Narration panel

**Files:**
- Modify: `src/components/modals/preferences/voice/NarrationPanel.tsx`
- Modify: `src/components/modals/preferences/voice/NarrationPanel.test.tsx`
- Modify: `src/components/modals/preferences/voice/VoicePage.tsx` (pass `onOpenServer`)
- Modify: `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: `useVoiceServersStore`, `ttsVoices(provider, model, server)` (Task 7), `PROVIDER_META.server` (Task 8).
- Produces: `NarrationPanel({ onOpenProvider, onOpenServer })`.

- [ ] **Step 1: i18n keys**

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceServerVoiceFree` | Voice id | Id da voz | 语音 ID |
| `prefs.voiceServerVoiceFreeHint` | This server does not list its voices; type the voice or reference id. | Este servidor não lista as vozes; digite o id da voz ou da referência. | 该服务器未列出语音；请输入语音或参考 ID。 |
| `prefs.voiceServerSendsText` | Narration text is sent to {server}. | O texto narrado é enviado para {server}. | 朗读文本会发送到 {server}。 |

- [ ] **Step 2: Write the failing panel tests**

In `NarrationPanel.test.tsx`: add `voiceServersList: vi.fn()` to the hoisted `tauri` mocks, `tauri.voiceServersList.mockReset().mockResolvedValue([server])` in `beforeEach`, `useVoiceServersStore.setState({ servers: [], loaded: false, health: {} })` in `beforeEach`, import `useVoiceServersStore`, and define:

```ts
const server = {
  id: 'V1StGXR8_Z5jdHi6B-myT',
  name: 'Chatterbox',
  kind: 'openai' as const,
  baseUrl: 'http://localhost:4123',
  model: null,
  hasKey: false,
}
```

Change every `render(<NarrationPanel onOpenProvider={() => undefined} />)` to also pass `onOpenServer={() => undefined}`. Then add:

```tsx
  it('picks a local server and lists its voices', async () => {
    tauri.ttsVoices.mockImplementation(async (provider?: string) =>
      provider === 'server' ? [{ id: 'pt-ref', name: 'pt-ref', language: '' }] : [],
    )
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Chatterbox' }))
    expect(prefs().voiceTts).toMatchObject({ provider: 'server', server: server.id, model: '' })
    await waitFor(() =>
      expect(tauri.ttsVoices).toHaveBeenCalledWith('server', undefined, server.id),
    )
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('pt-ref'))
  })

  it('offers a free-text voice when the server lists none', async () => {
    tauri.ttsVoices.mockResolvedValue([])
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'server', model: '', voice: null, rate: 1, server: server.id },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    const input = await screen.findByLabelText('prefs.voiceServerVoiceFree')
    fireEvent.change(input, { target: { value: 'narrador' } })
    fireEvent.blur(input)
    expect(prefs().voiceTts.voice).toBe('narrador')
  })
```

Run: `npx vitest run src/components/modals/preferences/voice/NarrationPanel.test.tsx` — Expected: the two new tests FAIL.

- [ ] **Step 3: Key the voice list by server**

In `NarrationPanel.tsx`:

1. Add the prop `onOpenServer: (id: string | null) => void`.
2. Import `useVoiceServersStore` and read `servers`, `loaded`, `refresh`; add `useEffect(() => { if (!loaded) void refresh() }, [loaded, refresh])`.
3. Replace the list key and fetch so a server's id takes the model's place:

```tsx
  const listModel = choice.provider === 'server' ? (choice.server ?? '') : choice.model
  const voicesKey = voiceListKey(choice.provider, listModel)

  useEffect(() => {
    if (fromCatalog) return
    let cancelled = false
    const key = voiceListKey(choice.provider, listModel)
    const request =
      choice.provider === 'server'
        ? ttsVoices('server', undefined, listModel)
        : ttsVoices(choice.provider, choice.model || undefined)
    void request
      .then((list) => {
        if (!cancelled) setFetched({ key, list })
      })
      .catch(() => {
        if (!cancelled) setFetched({ key, list: [] })
      })
    return () => {
      cancelled = true
    }
  }, [choice.provider, choice.model, listModel, fromCatalog])
```

(The existing `ttsVoices(choice.provider, choice.model || undefined)` call becomes the `else` branch, so the existing tests keep asserting `toHaveBeenCalledWith('openai', 'gpt-4o-mini-tts')`.)

4. Add a server pick next to `pick`:

```tsx
  const pickServer = (id: string) => {
    if (choice.provider === 'server' && choice.server === id) return
    wantsDefault.current = voiceListKey('server', id)
    patch({ provider: 'server', server: id, model: '', voice: null })
  }
```

Also make `pick` clear the server: `patch({ provider, model, server: null, voice: ... })`, and the system card's `patch({ ...DEFAULT_TTS_CHOICE, rate: choice.rate, voice: null })` already carries `server: null` through `DEFAULT_TTS_CHOICE`.

- [ ] **Step 4: Render the server cards and the free-text voice**

Between the local `ProviderGroup` and the cloud `ProviderGroup`:

```tsx
        <ProviderGroup title={t('prefs.voiceGroupServers')}>
          {servers.map((server) => (
            <ProviderUseCard
              key={server.id}
              icon={PROVIDER_META.server.icon}
              title={server.name}
              description={t(
                server.kind === 'fish' ? 'prefs.voiceServerKindFish' : 'prefs.voiceServerKindOpenai',
              )}
              status="connected"
              selected={choice.provider === 'server' && choice.server === server.id}
              onSelect={() => pickServer(server.id)}
              note={t('prefs.voiceServerSendsText', { server: server.name })}
              footer={
                <button type="button" className={controls.btn} onClick={() => onOpenServer(server.id)}>
                  {t('prefs.voiceActionManage')}
                </button>
              }
            />
          ))}
          <button type="button" className={controls.btn} onClick={() => onOpenServer(null)}>
            {t('prefs.voiceServerAdd')}
          </button>
        </ProviderGroup>
```

In the voice field, when the chosen provider is a server whose list loaded empty, show a text input instead of the `Dropdown`:

```tsx
  const freeVoice = choice.provider === 'server' && voices !== null && voices.length === 0
  const freeVoiceId = useId()
  const [voiceDraft, setVoiceDraft] = useState(choice.voice ?? '')
  useEffect(() => setVoiceDraft(choice.voice ?? ''), [choice.voice])
```

```tsx
        {freeVoice ? (
          <div className={styles.field}>
            <label htmlFor={freeVoiceId}>{t('prefs.voiceServerVoiceFree')}</label>
            <input
              id={freeVoiceId}
              className={controls.input}
              spellCheck={false}
              value={voiceDraft}
              onChange={(event) => setVoiceDraft(event.target.value)}
              onBlur={() => patch({ voice: voiceDraft.trim() || null })}
            />
            <small className={styles.hint}>{t('prefs.voiceServerVoiceFreeHint')}</small>
          </div>
        ) : (
          /* the existing <label className={styles.field}> with the voice Dropdown, unchanged */
        )}
```

Place these hooks with the other hooks of the component (never after a conditional return), and add `useId` to the file's `react` import.

- [ ] **Step 5: Pass the prop from `VoicePage`**

`<NarrationPanel onOpenProvider={openProvider} onOpenServer={setServerDetail} />`

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/components/modals/preferences && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 7: Checkpoint (no commit)**

---

### Task 11: Documentation and full verification

**Files:**
- Modify: `docs/CHANGELOG.md` (`[Unreleased]`)
- Modify: `docs/VOICE.md`
- Modify: `docs/FEATURES.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` → the `### Added` list (create the subsection if missing), add:

```markdown
- **Local voice servers for narration.** Narration can speak through a text-to-speech server you
  run yourself — OpenAI-compatible (Chatterbox, Kokoro-FastAPI, openedai-speech, LocalAI) or Fish
  Speech — on this computer or your local network. Add servers in Preferences → Voice → Local
  servers; keys stay in the system keychain, public addresses are refused, and the system voice
  takes over when a server is unavailable.
```

- [ ] **Step 2: VOICE.md section**

Add a `## Local voice servers` section to `docs/VOICE.md` (after the cloud providers section) covering, in this order: what it is and why (PyTorch models stay outside the app); the two kinds and their endpoints (table from spec §6); storage (`{profile}/voice-servers.json`, keychain account `voice-server-{id}`, `hasKey` flag); network policy (allowed ranges, check at save and per request, pinned DNS, no proxy, no redirects, caps); narration flow and fallback (`voice://fallback` with `provider: "server"`); how to review (`cargo test voice_servers::`, the Review Focus list of the plan).

- [ ] **Step 3: FEATURES.md entry**

Add a short "Local voice servers" entry in the voice feature list of `docs/FEATURES.md`, matching the surrounding entries' format, pointing to `docs/VOICE.md#local-voice-servers`.

- [ ] **Step 4: Full verification**

Run, from the repo root:

```bash
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cd ..
npm test
npm run build
```

Expected: all Rust tests pass, clippy clean, all vitest suites pass, `npm run build` (tsc + i18n check + vite) succeeds. Do **not** run `npm run app`.

- [ ] **Step 5: Manual check through HMR (if the app is already running)**

With a real server (for example `docker run -p 4123:4123 travisvn/chatterbox-tts-api` or Fish Speech's `python -m tools.api_server --listen 127.0.0.1:8080`): Preferences → Voice → Add server → Save → status Online · N voices → Use for narration → Narration tab → Test. Then stop the server and Test again: the system voice speaks and a "Local server" fallback toast appears.

- [ ] **Step 6: Checkpoint (no commit)** — report `git status --short` to the owner; he decides on the commit.

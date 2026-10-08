# Guiding the install of ai-memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turning on AI Memory leads to a working install from inside Alethe, and the agents it
launches capture to that memory as well as query it.

**Architecture:** `src-tauri/src/ai_memory.rs` already ships the query half — detection and
per-agent MCP config writing. This plan extends that module rather than adding one beside it: a
central binary resolver so an Alethe-installed copy is the one the agents get, then install, then
the `serve` child, then the capture hooks composed into the Claude settings file Alethe already
writes per terminal. The UI is a sub-panel under the existing feature toggle, the way `playwright`
already does it.

**Tech Stack:** Rust (Tauri 2), `reqwest`, `zip`, `sha2`, `tar`, `flate2`, `serde_json`; React 18 +
TypeScript, CSS Modules with `theme.css` tokens; Vitest; `cargo test`.

**Spec:** [`docs/superpowers/specs/2026-09-25-ai-memory-managed-service-design.md`](../specs/2026-09-25-ai-memory-managed-service-design.md)

## Already done

**Task 1 — the release asset chooser** is committed as `c822ca1`:
`release_asset(os, arch) -> Option<ReleaseAsset>` with `ReleaseAsset { file, url, sha256_url }`,
`AI_MEMORY_VERSION = "2.4.0"`, and two tests. Do not rewrite it; later tasks consume it.

## What is NOT in this plan

An earlier draft registered ai-memory through `mcp_store`. **Dropped.** The module already writes
the registration per agent — `ai_memory_mcp_config_path` for Claude (an ephemeral `--mcp-config`),
`ai_memory_opencode_config_write`, `ai_memory_codex_config_write` — and `useXtermSession.ts:1136`
already calls them at launch. A second mechanism would compete with a working one.

## Global Constraints

- ai-memory version targeted: **2.4.0**. Assets: `ai-memory-linux-x86_64.tar.gz`,
  `ai-memory-linux-aarch64.tar.gz`, `ai-memory-macos-x86_64.tar.gz`,
  `ai-memory-macos-aarch64.tar.gz`, `ai-memory-windows-x86_64.zip`. **No Windows `aarch64`.**
- Each asset has a sibling `<asset>.sha256`; the hash is its first whitespace-separated field.
- Default endpoint `127.0.0.1:49374` (`DEFAULT_ENDPOINT`), default command `ai-memory`
  (`DEFAULT_COMMAND`) — both already in `ai_memory.rs`.
- `install-hooks --agent <agent>` prints without applying. **Never pass `--apply`.**
- Claude hook events ai-memory emits: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PreCompact`, `Stop`, `SessionEnd`, `SubagentStart`, `SubagentStop`.
- One switch: `enabledFeatures.aiMemory` is the consent. Never add a second consent control.
- Every visible string goes through `t()` and is registered in **both**
  `src/lib/i18n/messages/en.ts` and `pt-BR.ts`; `npm run build` fails on a missing translation.
- CSS Modules plus tokens from `src/styles/theme.css`. Never a literal colour. No gradients.
- English in all code, comments and docs. `docs/CHANGELOG.md` gains an `[Unreleased]` entry.
- Commit only the files your task names. Never `git add -A`.
- Do not push or tag. Do not restart the app or the dev server.
- Rust tests run from `src-tauri/` with `CARGO_TARGET_DIR=target-test` — the app holds `alethe.exe`
  in the normal target directory.

## Review Focus

Five things the spec implies, that a person will meet, and that no happy path catches. Each has a
test pinned to the task that owns the code.

1. **Alethe installs into the profile folder, which is not on `PATH`.** The existing config writers
   default to the bare name `ai-memory`, so the agent would be handed a command it cannot resolve —
   the install would look successful and memory would silently never work. *Task 2.*
2. **The machine has no asset** (Windows ARM64): the panel says upstream publishes no build for it
   and offers no button, rather than failing on click. *Task 5.*
3. **The endpoint already answers** and Alethe did not start it — most likely the person's own
   instance. Report that instead of starting a second server that loses the bind, and do not offer a
   Stop that would not control it. *Tasks 4 and 5.*
4. **`install-hooks` output changes shape** between versions: composing refuses and leaves Alethe's
   own hooks intact rather than writing a half-merged file every terminal reads. *Task 6.*
5. **Consent is off, or was turned off** while a terminal is open: a terminal opened after that
   carries no capture hooks, and the one already open keeps what it launched with. *Task 6.*

---

## File Structure

**Create:**
- `src-tauri/src/ai_memory_hooks.rs` — the pure merge of ai-memory's hook entries into Alethe's
  hooks object. Its own file because it is the one piece with no I/O and the one most worth testing
  alone.
- `src/lib/aiMemory.ts` + `src/lib/aiMemory.test.ts` — the panel's pure decisions and IPC bindings.
- `src/components/modals/preferences/AiMemoryPanel.tsx` + `.module.css` — the sub-panel.

**Modify:**
- `src-tauri/src/ai_memory.rs` — resolver, install, lifecycle, hook config.
- `src-tauri/src/lib.rs` — module declaration, managed state, command registration.
- `src-tauri/Cargo.toml` — `tar`, `flate2`.
- `src-tauri/src/agent_events.rs` — compose the hooks in.
- `src/lib/tauri/agents.ts` — carry the consent to the hooks writer.
- `src/components/TerminalPane/index.tsx`, `src/components/AgentCanvasPOC/index.tsx`,
  `src/components/XTermView/useXtermSession.ts` — pass it from the live store.
- `src/components/modals/preferences/FeaturesPage.tsx` — mount the sub-panel.
- `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `docs/CHANGELOG.md`.

---

## Task 2: One place that decides which binary runs

**Files:**
- Modify: `src-tauri/src/ai_memory.rs`

**Interfaces:**
- Consumes: `release_asset` (done); `crate::paths::profile_data_dir(app) -> Result<PathBuf, String>`.
- Produces:
  - `pub fn binary_name() -> &'static str`
  - `pub fn install_dir(app: &AppHandle) -> Result<PathBuf, String>`
  - `pub fn managed_binary(app: &AppHandle) -> Option<String>`
  - `pub fn pick_command(managed: Option<String>, explicit: Option<String>) -> String`
  - `AiMemoryStatus` gains `managed: bool` and `supported: bool`.

This is Review Focus #1, and it comes first because everything later depends on the agents actually
receiving a usable command. `ai_memory_detect` and the three config writers all default to the bare
name; a copy in the profile folder is not on `PATH`, so without this the install is cosmetic.

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/ai_memory.rs`:

```rust
    #[test]
    fn an_explicit_command_always_wins() {
        // The caller named a binary; nothing may second-guess that.
        assert_eq!(
            pick_command(Some("/profile/ai-memory".into()), Some("/usr/bin/ai-memory".into())),
            "/usr/bin/ai-memory"
        );
        assert_eq!(pick_command(None, Some("/usr/bin/ai-memory".into())), "/usr/bin/ai-memory");
    }

    #[test]
    fn the_copy_alethe_installed_travels_as_a_full_path() {
        // It lives in the profile folder, which is not on PATH: handing the agent the bare name
        // would give it a command it cannot resolve, and memory would silently never work.
        assert_eq!(pick_command(Some("/profile/ai-memory".into()), None), "/profile/ai-memory");
    }

    #[test]
    fn with_nothing_installed_the_bare_name_is_tried() {
        // PATH may still hold one the person installed themselves.
        assert_eq!(pick_command(None, None), DEFAULT_COMMAND);
    }
```

- [ ] **Step 2: Run it to watch it fail**

From `src-tauri/`:
```
CARGO_TARGET_DIR=target-test cargo test --lib ai_memory::
```
Expected: does not compile — `pick_command` is not defined.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/ai_memory.rs`, after `release_asset`:

```rust
use std::path::PathBuf;

use tauri::AppHandle;

use crate::paths::profile_data_dir;

pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "ai-memory.exe"
    } else {
        "ai-memory"
    }
}

pub fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("tools").join("ai-memory"))
}

/// The copy Alethe installed, if it is there.
pub fn managed_binary(app: &AppHandle) -> Option<String> {
    let path = install_dir(app).ok()?.join(binary_name());
    path.is_file().then(|| path.to_string_lossy().to_string())
}

/// Which binary to run: what the caller asked for, else the managed copy by full path, else the
/// bare name for `PATH` to resolve.
///
/// The managed copy lives in the profile folder, so it has to travel as a path — the bare name
/// would not resolve for the agents the config writers hand it to.
pub fn pick_command(managed: Option<String>, explicit: Option<String>) -> String {
    explicit
        .or(managed)
        .unwrap_or_else(|| DEFAULT_COMMAND.to_string())
}
```

- [ ] **Step 4: Route every existing entry point through it**

Four commands in this file each take `command: Option<String>` and each begin with
`let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());`: `ai_memory_detect`,
`ai_memory_mcp_config_path`, `ai_memory_opencode_config_write`, `ai_memory_codex_config_write`.

Give each an `app: AppHandle` first parameter — Tauri injects it, so no TypeScript binding changes —
and replace that line with:

```rust
    let cmd = pick_command(managed_binary(&app), command);
```

Then extend the status struct so the panel can tell the two copies apart:

```rust
pub struct AiMemoryStatus {
    installed: bool,
    /// The server answers on the loopback endpoint.
    running: bool,
    command: String,
    endpoint: String,
    version: Option<String>,
    /// This is the copy Alethe installed, not one found on `PATH`.
    managed: bool,
    /// Upstream publishes a build for this machine. False on Windows ARM64.
    supported: bool,
}
```

and fill them in `ai_memory_detect`, replacing its `Ok(AiMemoryStatus { … })`:

```rust
    let managed = managed_binary(&app);
    let cmd = pick_command(managed.clone(), command);
    // …the existing --version probe and endpoint_alive call, unchanged…
    Ok(AiMemoryStatus {
        installed,
        running,
        managed: managed.as_deref() == Some(cmd.as_str()),
        supported: release_asset(std::env::consts::OS, std::env::consts::ARCH).is_some(),
        command: cmd,
        endpoint: DEFAULT_ENDPOINT.to_string(),
        version,
    })
```

While you are in this file, translate the one Portuguese comment on a line you touch —
`/// Servidor respondendo no endpoint loopback.` becomes `/// The server answers on the loopback
endpoint.` The repository's language rule asks for this whenever such a comment sits in a file being
changed.

- [ ] **Step 5: Run the tests**

Run: `CARGO_TARGET_DIR=target-test cargo test --lib ai_memory::`
Expected: 5 passed (2 from Task 1, 3 new).

Run: `CARGO_TARGET_DIR=target-test cargo test --lib`
Expected: the whole lib suite passes — four commands changed signature, so every caller must still
compile.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ai_memory.rs
git commit -m "feat(ai-memory): resolve the managed copy by path, so agents can run it"
```

---

## Task 3: Unpacking a tar.gz release

**Files:**
- Modify: `src-tauri/src/ai_memory.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `crate::plugin_package::safe_entry_path(name) -> Result<PathBuf, String>`.
- Produces: `pub fn extract_tar_gz(bytes: &[u8], destination: &Path) -> Result<(), String>`

Linux and macOS ship `.tar.gz`. Without this, install works on Windows only — the outcome the spec
exists to avoid.

- [ ] **Step 1: Write the failing test**

Add to `mod tests`:

```rust
    #[test]
    fn a_tarball_unpacks_and_refuses_an_entry_that_escapes() {
        use std::io::Write;

        fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
            let mut tar = tar::Builder::new(Vec::new());
            for (name, body) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, name, *body).unwrap();
            }
            let raw = tar.into_inner().unwrap();
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&raw).unwrap();
            gz.finish().unwrap()
        }

        let dir = std::env::temp_dir().join(format!("alethe-aimem-tar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        extract_tar_gz(&tar_gz(&[("ai-memory", b"binary")]), &dir).expect("a plain tarball unpacks");
        assert!(dir.join("ai-memory").is_file());

        let evil = tar_gz(&[("../escaped", b"nope")]);
        assert!(extract_tar_gz(&evil, &dir).is_err(), "an entry leaving the directory is refused");
        assert!(!dir.parent().unwrap().join("escaped").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run it to watch it fail**

Run: `CARGO_TARGET_DIR=target-test cargo test --lib ai_memory::a_tarball`
Expected: does not compile — `extract_tar_gz` undefined, `tar`/`flate2` not in scope.

- [ ] **Step 3: Add the dependencies**

In `src-tauri/Cargo.toml`, in `[dependencies]` beside `zip = "0.6"`:

```toml
tar = "0.4"
flate2 = "1"
```

- [ ] **Step 4: Write the implementation**

In `src-tauri/src/ai_memory.rs`:

```rust
use std::path::Path;

use crate::plugin_package::safe_entry_path;

/// Unpacks a `.tar.gz` release, refusing any entry whose path leaves `destination`.
///
/// The same rule `extract_zip` applies, through the same `safe_entry_path`: an archive from the
/// internet does not choose where its files land.
pub fn extract_tar_gz(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    std::fs::create_dir_all(destination).map_err(|e| format!("mkdir_failed:{e}"))?;
    for entry in archive.entries().map_err(|e| format!("tar_read_failed:{e}"))? {
        let mut entry = entry.map_err(|e| format!("tar_read_failed:{e}"))?;
        let name = entry.path().map_err(|e| format!("tar_read_failed:{e}"))?;
        let target = destination.join(safe_entry_path(&name.to_string_lossy())?);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir_failed:{e}"))?;
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err("tar_entry_not_a_file".to_string());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
        }
        entry.unpack(&target).map_err(|e| format!("tar_unpack_failed:{e}"))?;
    }
    Ok(())
}
```

- [ ] **Step 5: Run the tests**

Run: `CARGO_TARGET_DIR=target-test cargo test --lib ai_memory::`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/ai_memory.rs
git commit -m "feat(ai-memory): unpack the tar.gz releases Linux and macOS ship"
```

---

## Task 4: Install, and the serve child

**Files:**
- Modify: `src-tauri/src/ai_memory.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `release_asset`, `install_dir`, `binary_name`, `managed_binary`, `pick_command`,
  `extract_tar_gz`, the existing `endpoint_alive(&str) -> bool` and `hide_console(&mut Command)`;
  from `crate::plugin_package`: **`download_bounded(url, max_bytes)`** and
  **`extract_zip_bounded(bytes, destination, max_entries, max_bytes)`** — never the plain `download`
  or `extract_zip`, whose caps are sized for a plugin (8 MiB downloaded, 32 MiB unpacked) and would
  refuse ai-memory's 17.6 MB asset and 46 MB binary outright; plus
  `verify_sha256(bytes, expected) -> Result<(), String>` and `is_sha256(value) -> bool`.
  ai-memory's own caps live in `ai_memory.rs`: `MAX_DOWNLOAD_BYTES` (64 MiB),
  `MAX_UNPACKED_BYTES` (192 MiB), `MAX_ENTRIES` (4000).
- Produces:
  - `pub const DEFAULT_PORT: u16 = 49374`
  - `pub fn parse_sha256_file(body: &str) -> Option<String>`
  - `pub struct Counts { pub sessions: u64, pub observations: u64, pub pages: u64 }`
  - `pub fn parse_counts(stdout: &str) -> Counts`
  - `pub struct AiMemoryProcess(pub Mutex<Option<Child>>)` — Tauri managed state
  - `pub(crate) fn command_for(app: &AppHandle, explicit: Option<String>) -> (String, Option<String>)`
  - `pub(crate) fn base_command(cmd: &str, data_dir: Option<&str>) -> Command`
  - `ai_memory_install`, `ai_memory_start`, `ai_memory_stop`, `ai_memory_counts` commands.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests`:

```rust
    #[test]
    fn the_hash_file_is_read_from_its_first_field() {
        // The published file is "<hash>  <filename>".
        let body = "4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50  ai-memory-windows-x86_64.zip\n";
        assert_eq!(
            parse_sha256_file(body).as_deref(),
            Some("4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50")
        );
        assert!(parse_sha256_file("").is_none());
        assert!(parse_sha256_file("not-a-hash  file.zip").is_none());
    }

    #[test]
    fn the_counts_come_from_the_binarys_own_status() {
        // Real `ai-memory status` output, trimmed. Alethe reports what the service says about
        // itself rather than keeping a tally of its own that can drift.
        let out = "ai-memory 2.4.0 (server)\n  \
                   pages:        3 (all versions: 4)\n  \
                   sessions:     2\n  \
                   observations: 17\n";
        let counts = parse_counts(out);
        assert_eq!((counts.pages, counts.sessions, counts.observations), (3, 2, 17));
    }

    #[test]
    fn a_store_with_nothing_in_it_reads_as_zero_not_as_an_error() {
        // A freshly reset store prints no count lines. Zero is the truth there; failing would make
        // the panel show an error for a healthy, empty service.
        let counts = parse_counts("ai-memory 2.4.0 (server)\n");
        assert_eq!((counts.pages, counts.sessions, counts.observations), (0, 0, 0));
    }
```

- [ ] **Step 2: Run them to watch them fail**

Run: `CARGO_TARGET_DIR=target-test cargo test --lib ai_memory::`
Expected: does not compile — `parse_sha256_file`, `parse_counts`, `Counts` undefined.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/ai_memory.rs`:

```rust
use std::process::{Child, Stdio};
use std::sync::Mutex;

use crate::plugin_package::{download_bounded, extract_zip_bounded, is_sha256, verify_sha256};

pub const DEFAULT_PORT: u16 = 49374;

/// The published `.sha256` is `<hash>  <filename>`; only the hash is ours to use.
pub fn parse_sha256_file(body: &str) -> Option<String> {
    let first = body.split_whitespace().next()?.to_ascii_lowercase();
    is_sha256(&first).then_some(first)
}

#[derive(Debug, Default, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub sessions: u64,
    pub observations: u64,
    pub pages: u64,
}

/// Reads the counts out of `ai-memory status`.
///
/// Anything unrecognised stays zero: an empty store prints no count lines, and that is a healthy
/// service with nothing in it, not a failure to report.
pub fn parse_counts(stdout: &str) -> Counts {
    let mut counts = Counts::default();
    for line in stdout.lines() {
        let Some((label, rest)) = line.trim().split_once(':') else { continue };
        let Some(value) = rest.trim().split_whitespace().next().and_then(|v| v.parse().ok()) else {
            continue;
        };
        match label.trim() {
            "sessions" => counts.sessions = value,
            "observations" => counts.observations = value,
            "pages" => counts.pages = value,
            _ => {}
        }
    }
    counts
}

#[derive(Default)]
pub struct AiMemoryProcess(pub Mutex<Option<Child>>);

/// The data directory for a copy Alethe installed. A copy the person installed themselves keeps its
/// data where they put it, so this is never passed for one of those.
fn managed_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("ai-memory-data"))
}

/// The command to run and, only for a copy Alethe installed, the data directory to give it.
pub(crate) fn command_for(app: &AppHandle, explicit: Option<String>) -> (String, Option<String>) {
    let managed = managed_binary(app);
    let cmd = pick_command(managed.clone(), explicit);
    let data_dir = if managed.as_deref() == Some(cmd.as_str()) {
        managed_data_dir(app).ok().map(|d| d.to_string_lossy().to_string())
    } else {
        None
    };
    (cmd, data_dir)
}

pub(crate) fn base_command(cmd: &str, data_dir: Option<&str>) -> Command {
    let mut command = Command::new(cmd);
    if let Some(dir) = data_dir {
        command.arg("--data-dir").arg(dir);
    }
    hide_console(&mut command);
    command
}

/// Downloads the asset for this platform, checks it against the hash the release publishes, and
/// unpacks it into the profile folder. Returns the path to the binary.
#[tauri::command]
pub async fn ai_memory_install(app: AppHandle) -> Result<String, String> {
    let asset = release_asset(std::env::consts::OS, std::env::consts::ARCH)
        .ok_or_else(|| "ai_memory_unsupported_platform".to_string())?;

    // The hash file is a line of text; the asset is tens of megabytes. Both go through the bounded
    // helpers with ai-memory's own caps — the plugin ones would refuse this download.
    let expected = parse_sha256_file(&String::from_utf8_lossy(
        &download_bounded(&asset.sha256_url, 4 * 1024).await?,
    ))
    .ok_or_else(|| "ai_memory_bad_hash_file".to_string())?;
    let bytes = download_bounded(&asset.url, MAX_DOWNLOAD_BYTES).await?;
    verify_sha256(&bytes, &expected)?;

    let dir = install_dir(&app)?;
    let _ = std::fs::remove_dir_all(&dir);
    if asset.file.ends_with(".zip") {
        extract_zip_bounded(&bytes, &dir, MAX_ENTRIES, MAX_UNPACKED_BYTES)?;
    } else {
        extract_tar_gz(&bytes, &dir)?;
    }

    let binary = dir.join(binary_name());
    if !binary.is_file() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("ai_memory_binary_missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&binary)
            .map_err(|e| format!("stat_failed:{e}"))?
            .permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(&binary, perms).map_err(|e| format!("chmod_failed:{e}"))?;
    }
    Ok(binary.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ai_memory_counts(app: AppHandle, command: Option<String>) -> Result<Counts, String> {
    let (cmd, data_dir) = command_for(&app, command);
    let output = base_command(&cmd, data_dir.as_deref())
        .arg("status")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("ai_memory_status:{e}"))?;
    Ok(parse_counts(&String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
pub fn ai_memory_start(
    app: AppHandle,
    state: tauri::State<'_, AiMemoryProcess>,
    port: Option<u16>,
) -> Result<(), String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let (cmd, data_dir) = command_for(&app, None);

    let mut guard = state.0.lock().map_err(|_| "ai_memory_lock".to_string())?;
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    // Something else holds the endpoint — most likely the person's own instance. Starting anyway
    // would fail the bind and leave a dead child behind.
    if endpoint_alive(&format!("127.0.0.1:{port}")) {
        return Err("ai_memory_port_in_use".to_string());
    }

    let child = base_command(&cmd, data_dir.as_deref())
        .arg("serve")
        .arg("--transport")
        .arg("http")
        .arg("--bind")
        .arg(format!("127.0.0.1:{port}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ai_memory_spawn:{e}"))?;
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
pub fn ai_memory_stop(state: tauri::State<'_, AiMemoryProcess>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "ai_memory_lock".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}
```

`endpoint_alive` and `hide_console` already exist in this file and in `git_control`; reuse them
rather than writing a second port probe or window-hiding helper.

In `src-tauri/src/lib.rs`, manage the state beside `Router9Process`:

```rust
        .manage(ai_memory::AiMemoryProcess::default())
```

and register the commands beside the existing `ai_memory::` entries:

```rust
            ai_memory::ai_memory_install,
            ai_memory::ai_memory_start,
            ai_memory::ai_memory_stop,
            ai_memory::ai_memory_counts,
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=target-test cargo test --lib ai_memory::` — expected: 9 passed.
Run: `CARGO_TARGET_DIR=target-test cargo check --bins` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ai_memory.rs src-tauri/src/lib.rs
git commit -m "feat(ai-memory): install a verified copy, and run it"
```

---

## Task 5: The panel's decisions, in TypeScript

**Files:**
- Create: `src/lib/aiMemory.ts`, `src/lib/aiMemory.test.ts`

**Interfaces:**
- Consumes: the commands from Task 4; the existing `aiMemoryDetect` binding in `src/lib/tauri/`.
- Produces:
  - `export type AiMemoryStatus = { installed: boolean; running: boolean; command: string; endpoint: string; version: string | null; managed: boolean; supported: boolean }`
  - `export type AiMemoryCounts = { sessions: number; observations: number; pages: number }`
  - `export function offerInstall(status: AiMemoryStatus | null): boolean`
  - `export function canStart(status: AiMemoryStatus | null): boolean`
  - `export function portOwnedByOther(status: AiMemoryStatus | null, weStartedIt: boolean): boolean`
  - `export function normalizePort(port: number): number`
  - `export const AI_MEMORY_DEFAULT_PORT = 49374`, `export const AI_MEMORY_REPO`
  - `aiMemoryInstall`, `aiMemoryStart`, `aiMemoryStop`, `aiMemoryCounts` bindings.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/aiMemory.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  type AiMemoryStatus,
  canStart,
  normalizePort,
  offerInstall,
  portOwnedByOther,
} from './aiMemory'

function status(patch: Partial<AiMemoryStatus> = {}): AiMemoryStatus {
  return {
    installed: false,
    running: false,
    command: 'ai-memory',
    endpoint: '127.0.0.1:49374',
    version: null,
    managed: false,
    supported: true,
    ...patch,
  }
}

describe('whether the panel offers to install', () => {
  it('offers when nothing is installed and upstream builds for this machine', () => {
    expect(offerInstall(status())).toBe(true)
  })

  it('does not offer on a machine upstream publishes no build for', () => {
    // Windows on ARM. Saying so beats a button that downloads a 404.
    expect(offerInstall(status({ supported: false }))).toBe(false)
  })

  it('does not offer when a binary is already there', () => {
    expect(offerInstall(status({ installed: true }))).toBe(false)
  })

  it('offers nothing while the status is unknown', () => {
    expect(offerInstall(null)).toBe(false)
  })
})

describe('whether starting is offered', () => {
  it('needs a binary', () => {
    expect(canStart(status())).toBe(false)
    expect(canStart(status({ installed: true }))).toBe(true)
  })

  it('is not offered while something already answers on the endpoint', () => {
    expect(canStart(status({ installed: true, running: true }))).toBe(false)
  })
})

describe('who owns the endpoint', () => {
  it('names a server Alethe did not start', () => {
    // Most likely the person's own instance: a reason to leave it alone, not to fight for the bind.
    expect(portOwnedByOther(status({ installed: true, running: true }), false)).toBe(true)
  })

  it('says nothing when the running server is ours', () => {
    expect(portOwnedByOther(status({ installed: true, running: true }), true)).toBe(false)
  })

  it('says nothing when nothing is running', () => {
    expect(portOwnedByOther(status({ installed: true }), false)).toBe(false)
  })
})

describe('the port a person can type', () => {
  it('keeps a usable port and falls back to the default otherwise', () => {
    expect(normalizePort(50000)).toBe(50000)
    expect(normalizePort(0)).toBe(49374)
    expect(normalizePort(70000)).toBe(49374)
    expect(normalizePort(Number.NaN)).toBe(49374)
  })
})
```

- [ ] **Step 2: Run them to watch them fail**

Run: `npx vitest run src/lib/aiMemory.test.ts`
Expected: FAIL — cannot resolve `./aiMemory`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/aiMemory.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

export const AI_MEMORY_DEFAULT_PORT = 49374
export const AI_MEMORY_REPO = 'https://github.com/akitaonrails/ai-memory'

export type AiMemoryStatus = {
  installed: boolean
  /** Something answers on the loopback endpoint — not necessarily a server Alethe started. */
  running: boolean
  command: string
  endpoint: string
  version: string | null
  /** The binary is the copy Alethe installed, not one found on PATH. */
  managed: boolean
  /** Upstream publishes a build for this machine. */
  supported: boolean
}

export type AiMemoryCounts = { sessions: number; observations: number; pages: number }

export function offerInstall(status: AiMemoryStatus | null): boolean {
  return Boolean(status && !status.installed && status.supported)
}

export function canStart(status: AiMemoryStatus | null): boolean {
  return Boolean(status && status.installed && !status.running)
}

/** True when the endpoint answers and the server behind it is not the child Alethe started. */
export function portOwnedByOther(status: AiMemoryStatus | null, weStartedIt: boolean): boolean {
  return Boolean(status?.running) && !weStartedIt
}

export function normalizePort(port: number): number {
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : AI_MEMORY_DEFAULT_PORT
}

export async function aiMemoryInstall(): Promise<string> {
  return invoke<string>('ai_memory_install')
}

export async function aiMemoryStart(port?: number): Promise<void> {
  await invoke('ai_memory_start', { port })
}

export async function aiMemoryStop(): Promise<void> {
  await invoke('ai_memory_stop')
}

export async function aiMemoryCounts(): Promise<AiMemoryCounts> {
  return invoke<AiMemoryCounts>('ai_memory_counts', {})
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/aiMemory.test.ts`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/aiMemory.ts src/lib/aiMemory.test.ts
git commit -m "feat(ai-memory): the decisions the panel needs"
```

---

## Task 6: Capture — the hooks, and the consent that gates them

**Files:**
- Create: `src-tauri/src/ai_memory_hooks.rs`
- Modify: `src-tauri/src/ai_memory.rs`, `src-tauri/src/agent_events.rs`, `src-tauri/src/lib.rs`,
  `src/lib/tauri/agents.ts`, `src/components/TerminalPane/index.tsx`,
  `src/components/AgentCanvasPOC/index.tsx`, `src/components/XTermView/useXtermSession.ts`

**Interfaces:**
- Consumes: `command_for`, `base_command`, `DEFAULT_PORT` (Task 4);
  `AI_MEMORY_DEFAULT_PORT` (Task 5).
- Produces:
  - `pub fn merge_hooks(alethe: &mut Map<String, Value>, theirs: &Value) -> Result<(), String>`
  - `pub fn hook_config(app: &AppHandle, port: u16) -> Result<Value, String>`
  - `pub(crate) fn claude_hooks(app: &AppHandle, enabled: bool, port: u16) -> Option<Value>`
  - `agentHooksSettingsPath(plannerId, orchestrator, aiMemory)` in `src/lib/tauri/agents.ts`.

This is the half that does not exist. Alethe writes a Claude settings file per terminal with
`"type": "http"` hooks; ai-memory's `install-hooks` prints `"type": "command"` ones. They compose —
proven by running it — so Alethe writes both into its own file and never runs
`install-hooks --apply`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/ai_memory_hooks.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alethe_side() -> serde_json::Map<String, serde_json::Value> {
        // What `agent_hooks_settings_path` already builds: http hooks back to Alethe's listener.
        let hook = json!([{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:9123/hook" }] }]);
        let mut hooks = serde_json::Map::new();
        hooks.insert("SessionStart".into(), hook.clone());
        hooks.insert("UserPromptSubmit".into(), hook);
        hooks
    }

    fn their_side() -> serde_json::Value {
        json!({
            "SessionStart": [{ "matcher": "", "hooks": [
                { "type": "command", "command": "ai-memory", "args": ["hook", "--event", "session-start"] }
            ]}],
            "Stop": [{ "matcher": "", "hooks": [
                { "type": "command", "command": "ai-memory", "args": ["hook", "--event", "stop"] }
            ]}]
        })
    }

    #[test]
    fn both_sides_survive_on_an_event_they_share() {
        // Verified against the real CLI before this was designed: hook arrays from two settings
        // sources both fire. Losing either side breaks capture or orchestration, silently.
        let mut alethe = alethe_side();
        merge_hooks(&mut alethe, &their_side()).expect("merges");

        let start = alethe.get("SessionStart").unwrap().as_array().unwrap();
        assert_eq!(start.len(), 2, "Alethe's entry and theirs: {start:?}");
        let rendered = serde_json::to_string(start).unwrap();
        assert!(rendered.contains("\"type\":\"http\""), "{rendered}");
        assert!(rendered.contains("session-start"), "{rendered}");
    }

    #[test]
    fn an_event_only_ai_memory_wants_is_added() {
        let mut alethe = alethe_side();
        merge_hooks(&mut alethe, &their_side()).unwrap();
        assert_eq!(alethe.get("Stop").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_event_only_alethe_wants_is_untouched() {
        let mut alethe = alethe_side();
        merge_hooks(&mut alethe, &their_side()).unwrap();
        assert_eq!(alethe.get("UserPromptSubmit").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_unfamiliar_shape_is_refused_and_changes_nothing() {
        // Every terminal reads this file. A half-merged one breaks all of them, so a shape we do
        // not recognise must leave Alethe's own hooks exactly as they were.
        for bad in [json!("nope"), json!(["SessionStart"]), json!({ "SessionStart": 3 })] {
            let mut alethe = alethe_side();
            let before = serde_json::to_string(&alethe).unwrap();
            assert!(merge_hooks(&mut alethe, &bad).is_err(), "{bad:?}");
            assert_eq!(serde_json::to_string(&alethe).unwrap(), before, "left intact");
        }
    }
}
```

- [ ] **Step 2: Run them to watch them fail**

Run: `CARGO_TARGET_DIR=target-test cargo test --lib ai_memory_hooks::`
Expected: does not compile — the module is not declared and `merge_hooks` does not exist.

- [ ] **Step 3: Write the merge**

At the top of `src-tauri/src/ai_memory_hooks.rs`:

```rust
//! Merging ai-memory's lifecycle hooks into the settings file Alethe writes per terminal.
//!
//! Alethe owns that file, so this is the only place either side's hooks meet: the person's own
//! `settings.json` is never touched, the scope is one terminal, and stopping the integration simply
//! stops writing them.

use serde_json::{Map, Value};

/// Adds ai-memory's hook entries to Alethe's hooks object.
///
/// Arrays for a shared event are concatenated rather than replaced, which is how Claude Code treats
/// hooks from several settings sources. All or nothing: a shape we do not recognise leaves `alethe`
/// exactly as it was.
pub fn merge_hooks(alethe: &mut Map<String, Value>, theirs: &Value) -> Result<(), String> {
    let theirs = theirs
        .as_object()
        .ok_or_else(|| "ai_memory_hooks_not_an_object".to_string())?;

    let mut additions: Vec<(String, Vec<Value>)> = Vec::new();
    for (event, entries) in theirs {
        let entries = entries
            .as_array()
            .ok_or_else(|| format!("ai_memory_hooks_event_not_an_array:{event}"))?;
        additions.push((event.clone(), entries.clone()));
    }

    for (event, entries) in additions {
        match alethe.get_mut(&event).and_then(Value::as_array_mut) {
            Some(existing) => existing.extend(entries),
            None => {
                alethe.insert(event, Value::Array(entries));
            }
        }
    }
    Ok(())
}
```

Declare it in `src-tauri/src/lib.rs` beside `mod ai_memory;`:

```rust
mod ai_memory_hooks;
```

- [ ] **Step 4: Read the hook config out of the CLI**

In `src-tauri/src/ai_memory.rs`:

```rust
/// The `hooks` object `install-hooks` prints for claude-code.
///
/// Never `--apply`: Alethe writes these into its own per-terminal file, not into the person's
/// settings.
pub fn hook_config(app: &AppHandle, port: u16) -> Result<serde_json::Value, String> {
    let (cmd, data_dir) = command_for(app, None);
    let output = base_command(&cmd, data_dir.as_deref())
        .arg("install-hooks")
        .arg("--agent")
        .arg("claude-code")
        .arg("--server-url")
        .arg(format!("http://127.0.0.1:{port}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("ai_memory_install_hooks:{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // The command prints comment lines before the JSON body.
    let start = stdout.find('{').ok_or_else(|| "ai_memory_hooks_no_json".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(stdout[start..].trim())
        .map_err(|e| format!("ai_memory_hooks_bad_json:{e}"))?;
    parsed
        .get("hooks")
        .cloned()
        .ok_or_else(|| "ai_memory_hooks_missing_key".to_string())
}

/// The hooks to merge, or `None` when consent is off or the binary is not there.
///
/// A failure here is not worth failing a terminal launch over: no hooks means no capture, and the
/// panel is where a person finds out why.
pub(crate) fn claude_hooks(app: &AppHandle, enabled: bool, port: u16) -> Option<serde_json::Value> {
    if !enabled {
        return None;
    }
    hook_config(app, port).ok()
}
```

- [ ] **Step 5: Compose them into the settings file**

In `src-tauri/src/agent_events.rs`, `agent_hooks_settings_path` gains an `AppHandle` and two
parameters:

```rust
pub fn agent_hooks_settings_path(
    app: AppHandle,
    planner_id: String,
    orchestrator: Option<bool>,
    ai_memory_enabled: Option<bool>,
    ai_memory_port: Option<u16>,
) -> Result<String, String> {
```

and just before `settings.insert("hooks".to_string(), …)`:

```rust
    // Capture rides in the same file, so one writer owns it and the scope is this terminal.
    // `merge_hooks` refuses an unfamiliar shape rather than writing a broken file.
    let ai_port = ai_memory_port.unwrap_or(crate::ai_memory::DEFAULT_PORT);
    let ai_on = ai_memory_enabled.unwrap_or(false);
    if let Some(theirs) = crate::ai_memory::claude_hooks(&app, ai_on, ai_port) {
        if let Err(error) = crate::ai_memory_hooks::merge_hooks(&mut hooks, &theirs) {
            eprintln!("[ai_memory] hooks not merged: {error}");
        }
    }
```

- [ ] **Step 6: Carry the consent from the live store**

In `src/lib/tauri/agents.ts`:

```ts
export async function agentHooksSettingsPath(
  plannerId: string,
  orchestrator = true,
  aiMemory: { enabled: boolean; port: number } | null = null,
): Promise<string> {
  return invoke<string>('agent_hooks_settings_path', {
    plannerId,
    orchestrator,
    aiMemoryEnabled: aiMemory?.enabled ?? false,
    aiMemoryPort: aiMemory?.port ?? null,
  })
}
```

The value comes from the store at call time, not from a file: `projects.json` is written with a
debounce, so a terminal opened right after the person turns capture off would otherwise still get
the hooks.

Add this helper to each of the three files that call it, at module level:

```tsx
function aiMemoryPrefs() {
  const prefs = useProjectsStore.getState().preferences
  return { enabled: prefs.enabledFeatures.aiMemory, port: AI_MEMORY_DEFAULT_PORT }
}
```

importing `AI_MEMORY_DEFAULT_PORT` from the right relative path to `src/lib/aiMemory`
(`'../../lib/aiMemory'` from both `TerminalPane/index.tsx` and `XTermView/useXtermSession.ts`,
`'../../lib/aiMemory'` from `AgentCanvasPOC/index.tsx`), and pass it as the third argument at each
call site:

- `src/components/TerminalPane/index.tsx:232` — inside the existing
  `await agentHooksSettingsPath(ptyId, …)` call.
- `src/components/AgentCanvasPOC/index.tsx:209` — inside
  `Promise.all([agentHooksEndpoint(), agentHooksSettingsPath(session.ptyId)])`.
- `src/components/XTermView/useXtermSession.ts` — at its `agentHooksSettingsPath` call.

- [ ] **Step 7: Run the tests**

Run: `CARGO_TARGET_DIR=target-test cargo test --lib` — expected: the four new `ai_memory_hooks`
tests pass and the rest of the suite is unchanged.
Run: `npx tsc --noEmit` — expected: clean; the binding gained an optional parameter, so an untouched
caller still compiles.
Run: `npm test` — expected: every suite passes. `src/components/XTermView/useXtermSession.test.ts`
mocks `agentHooksSettingsPath` (line 66); confirm the mock still satisfies the signature.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/ai_memory_hooks.rs src-tauri/src/ai_memory.rs src-tauri/src/agent_events.rs src-tauri/src/lib.rs src/lib/tauri/agents.ts src/components/TerminalPane/index.tsx src/components/AgentCanvasPOC/index.tsx src/components/XTermView/useXtermSession.ts
git commit -m "feat(ai-memory): capture hooks in Alethe's own per-terminal settings"
```

---

## Task 7: The sub-panel under the toggle

**Files:**
- Create: `src/components/modals/preferences/AiMemoryPanel.tsx`, `AiMemoryPanel.module.css`
- Modify: `src/components/modals/preferences/FeaturesPage.tsx:51`,
  `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `docs/CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Task 5; the existing `aiMemoryDetect` binding.
- Produces: `export function AiMemoryPanel()`.

`FeaturesPage.tsx:51` already renders `feature.id === 'playwright' && enabled ? (…)` as a sub-panel
in `styles.featureSubPanel`. ai-memory gets the same, so the guidance arrives where the person just
asked for the feature.

- [ ] **Step 1: Add the strings, both files**

In `src/lib/i18n/messages/en.ts`:

```ts
  // ai-memory's sub-panel, under its switch in Features.
  'aiMemory.panelCaptures':
    'Every prompt and tool call from agents Alethe launches is recorded, as markdown in a git repository plus a search index — both on this machine, both readable without Alethe.',
  'aiMemory.install': 'Install ai-memory',
  'aiMemory.installing': 'Installing…',
  'aiMemory.installedManaged': 'Installed by Alethe',
  'aiMemory.installedExternal': 'Using the copy you installed',
  'aiMemory.at': 'at {path}',
  'aiMemory.missing': 'Not installed yet — install it and the agents can start using it.',
  'aiMemory.unsupported':
    'ai-memory publishes no build for this platform yet, so Alethe cannot install it here.',
  'aiMemory.openRepo': 'Open the project',
  'aiMemory.start': 'Start',
  'aiMemory.stop': 'Stop',
  'aiMemory.running': 'Answering on {endpoint}',
  'aiMemory.stopped': 'Not running',
  'aiMemory.portBusy':
    'Something already answers on {endpoint} and Alethe did not start it — most likely your own copy. Alethe will leave it alone.',
  'aiMemory.counts': '{pages} pages · {sessions} sessions · {observations} observations',
  'aiMemory.installError': 'ai-memory could not be installed.',
  'aiMemory.startError': 'ai-memory could not be started.',
```

In `src/lib/i18n/messages/pt-BR.ts`:

```ts
  // ai-memory's sub-panel, under its switch in Features.
  'aiMemory.panelCaptures':
    'Todo prompt e toda chamada de ferramenta dos agentes que o Alethe inicia são registrados, como markdown num repositório git mais um índice de busca — os dois nesta máquina, os dois legíveis sem o Alethe.',
  'aiMemory.install': 'Instalar o ai-memory',
  'aiMemory.installing': 'Instalando…',
  'aiMemory.installedManaged': 'Instalado pelo Alethe',
  'aiMemory.installedExternal': 'Usando a cópia que você instalou',
  'aiMemory.at': 'em {path}',
  'aiMemory.missing': 'Ainda não instalado — instale e os agentes já podem usar.',
  'aiMemory.unsupported':
    'O ai-memory ainda não publica build para esta plataforma, então o Alethe não consegue instalar aqui.',
  'aiMemory.openRepo': 'Abrir o projeto',
  'aiMemory.start': 'Iniciar',
  'aiMemory.stop': 'Parar',
  'aiMemory.running': 'Respondendo em {endpoint}',
  'aiMemory.stopped': 'Parado',
  'aiMemory.portBusy':
    'Algo já responde em {endpoint} e não foi o Alethe que iniciou — provavelmente a sua própria cópia. O Alethe não vai mexer nela.',
  'aiMemory.counts': '{pages} páginas · {sessions} sessões · {observations} observações',
  'aiMemory.installError': 'Não foi possível instalar o ai-memory.',
  'aiMemory.startError': 'Não foi possível iniciar o ai-memory.',
```

- [ ] **Step 2: Write the panel**

Create `src/components/modals/preferences/AiMemoryPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'

import {
  AI_MEMORY_DEFAULT_PORT,
  AI_MEMORY_REPO,
  type AiMemoryCounts,
  type AiMemoryStatus,
  aiMemoryCounts,
  aiMemoryInstall,
  aiMemoryStart,
  aiMemoryStop,
  canStart,
  offerInstall,
  portOwnedByOther,
} from '../../../lib/aiMemory'
import { useT } from '../../../lib/i18n'
import { aiMemoryDetect } from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import styles from './AiMemoryPanel.module.css'

export function AiMemoryPanel() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const [status, setStatus] = useState<AiMemoryStatus | null>(null)
  const [counts, setCounts] = useState<AiMemoryCounts | null>(null)
  const [busy, setBusy] = useState<'install' | 'start' | 'stop' | null>(null)
  // Whether the running server is the child Alethe started. Without this, a server the person runs
  // themselves would be reported as ours and Stop would look like it controls it.
  const [ours, setOurs] = useState(false)

  const refresh = useCallback(async () => {
    const next = await aiMemoryDetect().catch(() => null)
    setStatus(next)
    setCounts(next?.installed ? await aiMemoryCounts().catch(() => null) : null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (
    kind: 'install' | 'start' | 'stop',
    action: () => Promise<unknown>,
    errorKey: 'aiMemory.installError' | 'aiMemory.startError',
  ) => {
    setBusy(kind)
    try {
      await action()
      if (kind === 'start') setOurs(true)
      if (kind === 'stop') setOurs(false)
      await refresh()
    } catch (cause) {
      pushToast({ title: t(errorKey), body: String(cause) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.panel}>
      <p className={styles.captures}>{t('aiMemory.panelCaptures')}</p>

      <p className={styles.state}>
        {status?.installed
          ? `${t(status.managed ? 'aiMemory.installedManaged' : 'aiMemory.installedExternal')} — ${t('aiMemory.at', { path: status.command })}`
          : status?.supported === false
            ? t('aiMemory.unsupported')
            : t('aiMemory.missing')}
      </p>

      {status?.installed ? (
        <p className={styles.state}>
          {status.running
            ? t('aiMemory.running', { endpoint: status.endpoint })
            : t('aiMemory.stopped')}
          {counts
            ? ` · ${t('aiMemory.counts', {
                pages: counts.pages,
                sessions: counts.sessions,
                observations: counts.observations,
              })}`
            : ''}
        </p>
      ) : null}

      {portOwnedByOther(status, ours) ? (
        <p className={styles.warning}>
          {t('aiMemory.portBusy', { endpoint: status?.endpoint ?? '' })}
        </p>
      ) : null}

      <div className={styles.actions}>
        {offerInstall(status) ? (
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={busy !== null}
            onClick={() => void run('install', aiMemoryInstall, 'aiMemory.installError')}
          >
            {busy === 'install' ? t('aiMemory.installing') : t('aiMemory.install')}
          </button>
        ) : null}
        {status?.running && ours ? (
          <button
            type="button"
            className={controls.btn}
            disabled={busy !== null}
            onClick={() => void run('stop', aiMemoryStop, 'aiMemory.startError')}
          >
            {t('aiMemory.stop')}
          </button>
        ) : (
          <button
            type="button"
            className={controls.btn}
            disabled={busy !== null || !canStart(status)}
            onClick={() =>
              void run('start', () => aiMemoryStart(AI_MEMORY_DEFAULT_PORT), 'aiMemory.startError')
            }
          >
            {t('aiMemory.start')}
          </button>
        )}
        <a className={styles.link} href={AI_MEMORY_REPO} target="_blank" rel="noreferrer">
          {t('aiMemory.openRepo')}
        </a>
      </div>
    </div>
  )
}
```

Create `src/components/modals/preferences/AiMemoryPanel.module.css`:

```css
.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.captures {
  max-width: 68ch;
  margin: 0;
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.55;
}
.state {
  margin: 0;
  color: var(--fg-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.warning {
  max-width: 68ch;
  margin: 0;
  color: var(--status-waiting);
  font-size: 11px;
  line-height: 1.5;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.link {
  color: var(--fg-muted);
  font-size: 11px;
}
.link:hover {
  color: var(--accent);
}
```

- [ ] **Step 3: Mount it**

In `src/components/modals/preferences/FeaturesPage.tsx`, after the playwright block's closing
`) : null}`, add the same shape for this feature:

```tsx
              {feature.id === 'aiMemory' && enabled ? (
                <div className={styles.featureSubPanel}>
                  <AiMemoryPanel />
                </div>
              ) : null}
```

with `import { AiMemoryPanel } from './AiMemoryPanel'` beside the other imports.

- [ ] **Step 4: Run everything**

Run: `npx tsc --noEmit` — expected: clean.
Run: `npm test` — expected: every suite passes, including Task 5's 11.
Run: `npm run build` — expected: exit 0. This is the i18n gate: a key missing from `pt-BR.ts` fails
here.

- [ ] **Step 5: Write the changelog entry**

First bullet under `[Unreleased]` → `### Added` in `docs/CHANGELOG.md`:

```markdown
- **Turning on AI Memory now takes you to a working install.** The switch in Preferences → Features
  grew a panel beneath it: whether ai-memory is there, a button to install it — the download checked
  against the hash the project publishes — and whether it is running, with what it has stored. And
  the agents Alethe launches now *record* to that memory as well as reading from it, so asking one
  what happened last week has something to find. Turning the switch on is what starts any of it, and
  what it records stays on your machine as markdown in a git repository you can read without Alethe.
```

- [ ] **Step 6: Commit**

```bash
git add src/components/modals/preferences/AiMemoryPanel.tsx src/components/modals/preferences/AiMemoryPanel.module.css src/components/modals/preferences/FeaturesPage.tsx src/lib/i18n/messages/en.ts src/lib/i18n/messages/pt-BR.ts docs/CHANGELOG.md
git commit -m "feat(ai-memory): guide the install from under its own switch"
```

---

## Manual verification, for a person at the keyboard

The suites cannot reach these:

1. With nothing installed, turn AI Memory on and follow the panel to a working install; confirm the
   state line then names the copy Alethe installed and its path.
2. Start it, open a Claude terminal, ask the agent something, and confirm the panel's counts move.
3. Turn the switch off, open a **new** terminal, ask something, and confirm the counts do not move —
   and that the terminal already open still works.
4. With an ai-memory of your own already running, confirm the panel says something else owns the
   endpoint, offers no Stop, and does not offer to install a second copy.

# Alethe — working guide (AI)

> Identical in content to [`AGENTS.md`](AGENTS.md) in this directory. Keep both in sync.
> Contributing from outside? Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, project
> layout, house rules, and PR convention.

## 1. What it is

**Alethe** is a **Windows-first** desktop app that organizes, operates, and resumes multiple coding
agents (Claude Code, Codex, OpenCode) and shells in parallel, inside a persistent workspace with
real terminals (PTYs), layouts, themes, history, and RAM control.

> Tagline: **Reveal the state of every agent, shell, and project.**
> Status: functional MVP in polish. Identifier: `com.kc1t.alethe`.

## 2. Commands (from `package.json`)

```powershell
npm install
npm run app      # = tauri dev — runs the full app with hot reload (RECOMMENDED WAY)
npm run dev      # Vite frontend only, at http://localhost:1422 (strictPort)
npm run build    # tsc + vite build — tsc typechecks and VALIDATES i18n (see §3)
npm test         # vitest run over src/**/*.test.{ts,tsx}
```

**Building the Windows installer (MSI/NSIS)** requires the MSVC environment (`vcvars64`):

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >NUL && npm run tauri build'
```

The folder depends on the Build Tools version: `2022\BuildTools` for Visual Studio 2022,
`18\BuildTools` for Visual Studio 2026. `vswhere -products * -property installationPath` (in
`C:\Program Files (x86)\Microsoft Visual Studio\Installer`) prints the installed one.

When returning the path of a generated installer, always report the **full absolute path on the PC**
(for example, `D:\project\src-tauri\target\release\bundle\nsis\Alethe_setup.exe`), never just the
path relative to the repository.



## 3. Non-negotiable rules

1. **DO NOT stop or restart the app or the dev server** (`tauri dev` / Vite). Do not kill the
   process, do not run `npm run app` "just to test" if it is already running. Apply changes through
   **HMR** and trust the reload.
2. **DO NOT commit / push / tag / release without explicit permission from the owner at that
   moment.** Make changes **in the working tree only** and stop — committing is his call. When he
   authorizes a commit, **DO NOT add a co-author** (`Co-Authored-By: Claude …`) or any tool
   signature to the message — he is the only author.
3. **Strict design system — no gradients, nothing "vibecoded".** No generic template UI. Dashboards
   and widgets show **real data**, never placeholder/mock. Style through CSS Modules + tokens from
   `src/styles/theme.css`; **never** hardcode a color — use the variables (`--bg`, `--fg`,
   `--accent`, `--agent-*`, `--status-*`, etc.).
4. **i18n is mandatory.** Every visible string goes through `t()`. When adding text, register the key
   in `src/lib/i18n/messages/en.ts` (**source of truth**, default EN) **and** in
   `src/lib/i18n/messages/pt-BR.ts`. `pt-BR.ts` is typed against the keys of `en.ts`, so
   `npm run build` **fails** if a translation is missing.
5. **Changelog is mandatory for features.** Every feature addition, change, or removal must update
   [`docs/CHANGELOG.md`](docs/CHANGELOG.md) in the same task, under the **`[Unreleased]`** section
   (top of the file), with a short, objective, user-facing description. Never skip this step — the
   changelog is the source for release notes.

## 4. Architecture at a glance

**Communication:** the frontend calls `invoke(...)` through `lib/tauri/`; the terminal receives
streaming through the Tauri events `pty://data/{id}` and `pty://exit/{id}`.

## 5. Conventions

- One `.module.css` file per component; color/spacing always through tokens, never literals.
- New domain types go in `src/lib/types.ts`; reuse the existing ones.
- **Every backend feature needs BOTH transports.** The app runs as a Tauri desktop app *and* as a
  Web/Core client, and which one is live is decided at runtime by `isTauriEnv()`. So:
  - Put the real logic in a plain `fn something_at(data_root: &Path, ...)`. The `#[tauri::command]`
    resolves the data root and calls it; the Axum route in `src-tauri/src/server_main/*_routes.rs`
    resolves it from `runtime.data_root()` and calls the same function. Never write the logic
    inside the command itself — the Web route then has nothing to reuse.
  - The TS wrapper must branch: `if (isTauriEnv()) return invoke(...)` else `webApiFetch(...)`.
    A wrapper that calls `invoke` unconditionally silently does nothing in Web mode.
  - `src/lib/api/coreRouteParity.contract.test.ts` fails when a Web operation has no matching
    route — if it starts failing on your feature, the second transport is missing, not the test.
- **Never swallow an error with `.catch(() => null)`** on a path that can legitimately return null.
  "Not addressed to this device", "the command doesn't exist in this build" and "it arrived but
  failed to open" then look identical — silence — and no amount of live testing can tell them
  apart. Log the failure, and distinguish it from the expected empty case.
- Lean Zustand selectors to avoid rerender loops; `projects.json` is saved with debounce and atomic
  writes (tmp → rename) — preserve that pattern.
- The `projects.json` schema is versioned with migration/backfill — when changing its shape, keep the
  migration.

## 6. Gotchas / security

- `tauri.conf.json` ships a strict CSP (`script-src 'self'`, `worker-src 'none'`), asserted literally
  by `src/securityPolicy.test.ts`. Any change there is a deliberate, reviewed one. Treat any
  rendered input as untrusted; the webview still has full IPC access.
- `spawn_pty` runs a shell with the command/args coming from the frontend — **validate input on the
  frontend** before spawning.
- OAuth tokens (Spotify, Claude) are stored in **plaintext** in app data; do not log or expose them.
- The Windows build requires `vcvars64`. The Rust toolchain on `C:` can be corrupted by Windows
  Defender — prefer building from `D:`.
- Local data: `%APPDATA%/Alethe/` (profiles, `projects.json`, scrollback `*.bin`, `spawn.log`).

## 7. Going deeper

Versioned in this repo:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup per OS, layout, house rules, commit/PR convention.
- [`docs/FEATURES.md`](docs/FEATURES.md) — features in detail.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — user-facing history.
- [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — domain model (Group, Project, Container, Pane, Terminal,
  Sub-tab, PTY), stack, and persistence.
- [`docs/BRAND.md`](docs/BRAND.md).
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — data flow, what's stored where, what's encrypted.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — aspirational, not a commitment; check before assuming an
  item is unimplemented.
- [`docs/PLUGINS.md`](docs/PLUGINS.md) — plugin system: manifest, capabilities, lifecycle, and how
  to add a bundled plugin.
- [`docs/THEMES.md`](docs/THEMES.md) — adding a theme, as a plugin or as a built-in.
- [`docs/UI_VISUAL_STYLES.md`](docs/UI_VISUAL_STYLES.md) — the two sidebar visual styles (Normal/Clean).
- [`docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md`](docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md)
  — current status, known gaps, and next steps for the project-collaboration feature (P2P sync,
  chat, tasks, mesh). Phase-by-phase history now lives in `docs/CHANGELOG.md`.
- [`docs/adr/`](docs/adr) — Architecture Decision Records for project collaboration (never edit an
  old ADR in place; a changed decision gets a new ADR that marks the old one superseded).
- [`docs/security/`](docs/security) — per-phase security gates and the sync threat model; audit
  history, not meant to be pruned as phases age.

The domain glossary (Group, Project, Container, Pane, Sub-tab, PTY) is summarized in `CONTRIBUTING.md`.

## Language and comment rules

- English is the default language for all versioned repository content, including source comments,
  JSDoc, documentation, changelog entries, user-facing strings, commit messages, and pull requests.
- Never add Portuguese prose to source comments, JSDoc, internal logs, or documentation. Translate any
  non-English comment encountered in a file being changed.
- Use another language only when the target file explicitly requires it. Locale files are the standard
  exception: translated UI text belongs in the matching locale file.
- When editing existing mixed-language content, translate the touched content to English when practical
  instead of extending the language inconsistency.
- Keep comments concise. Add them only when they explain non-obvious behavior, constraints, or decisions.

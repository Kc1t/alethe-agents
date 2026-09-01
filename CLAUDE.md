# Alethe — working guide (AI)

> Identical in content to [`AGENTS.md`](AGENTS.md) in this directory. Keep both in sync.
> Contributing from outside? Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, project
> layout, house rules, and PR convention.

## 1. What it is

**Alethe** is a **Windows-first** desktop app that organizes, operates, and resumes multiple coding
agents (Claude Code, Codex, OpenCode) and shells in parallel, inside a persistent workspace with
real terminals (PTYs), layouts, themes, history, and RAM control.

> Tagline: **Reveal the state of every agent, shell, and project.**
> Status: **v1.3.0**, functional MVP in polish. Identifier: `com.kc1t.alethe`.

## 2. Where you are

At the repository root — the app directory. It contains:

- `src/` — React frontend.
- `src-tauri/` — Rust/Tauri backend.
- `docs/` — versioned docs (`FEATURES.md`, `CHANGELOG.md`, `OVERVIEW.md`, `BRAND.md`, plus `adr/`
  and `security/` for the project-collaboration feature — see §9).
- `package.json`, `vite.config.ts`, `tsconfig.json`, `tests/`.

## 3. Stack

- **Frontend:** React 18.3 · TypeScript 5.6 · Vite 6 · Zustand 5 · xterm.js 5.5 (`@xterm/addon-fit`, `-search`, `-webgl`) · `react-resizable-panels` · `@dnd-kit/core` · `@radix-ui/react-dialog` · `lucide-react` · `nanoid`.
- **Backend:** Rust (edition 2021) · Tauri 2 · `portable-pty` (ConPTY on Windows) · `tokio` · `reqwest` · `keyring` · `serde`.
- **Styling:** CSS Modules + CSS custom properties (no Tailwind, no styled-components).

## 4. Commands (from `package.json`)

```powershell
npm install
npm run app      # = tauri dev — runs the full app with hot reload (RECOMMENDED WAY)
npm run dev      # Vite frontend only, at http://localhost:1422 (strictPort)
npm run build    # tsc + vite build — tsc typechecks and VALIDATES i18n (see §5)
npm test         # vitest run over tests/**/*.test.ts (test:node runs via node --test, separately)
```

**Building the Windows installer (MSI/NSIS)** requires the MSVC environment (`vcvars64`):

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >NUL && npm run tauri build'
```

When returning the path of a generated installer, always report the **full absolute path on the PC**
(for example, `D:\project\src-tauri\target\release\bundle\nsis\Alethe_setup.exe`), never just the
path relative to the repository.



## 5. Non-negotiable rules

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

## 6. Architecture at a glance

**Frontend (`src/`)**
- `components/` — UI by feature (`HomeView/`, `WorkspaceView/`, `XTermView/`, `ProjectSidebar/`, `TitleBar/`, `modals/`…). One `.module.css` per component.
- `stores/` — Zustand: `projectsStore` (projects/groups/terminals/preferences, **persisted** to `projects.json`) and `uiStore` (modals/toasts/ephemeral state).
- `lib/tauri/` — `invoke` wrapper, split by domain (`git`, `pty`, `agents`, `usage`…), with `index.ts` re-exporting everything — call sites keep importing from `lib/tauri` unchanged.
- `lib/i18n/` — the i18n system (`index.ts` + `messages/en.ts` + `messages/pt-BR.ts`).
- `lib/types.ts` — domain types (`AgentType`, `Terminal`, `Project`, `Group`, `GridLayout`…).
- `styles/theme.css` + `styles/reset.css` — tokens and reset.

**Backend (`src-tauri/src/`)**
- `lib.rs` — `invoke_handler` (registration of every `#[tauri::command]`).
- `pty.rs` — spawn/attach/write/resize/restart/kill of PTYs + on-disk scrollback.
- `projects.rs` — atomic load/save of `projects.json`. `profiles` — isolated multi-profile support.
- `cli_resolver.rs` — discovers CLIs (pwsh/powershell, Node managers, VS Code) on Windows.
- `claude_sessions.rs` / `codex_sessions.rs` / `claude_usage.rs` — session and usage reading.
- `spotify.rs`, `backup.rs`, `diagnostics.rs`, `agent_library.rs`, `agent_events.rs`, `stats.rs`.

**Communication:** the frontend calls `invoke(...)` through `lib/tauri/`; the terminal receives
streaming through the Tauri events `pty://data/{id}` and `pty://exit/{id}`.

## 7. Conventions

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

## 8. Gotchas / security

- `csp: null` in `tauri.conf.json` → the webview has full IPC access. Treat any rendered input as
  untrusted.
- `spawn_pty` runs a shell with the command/args coming from the frontend — **validate input on the
  frontend** before spawning.
- OAuth tokens (Spotify, Claude) are stored in **plaintext** in app data; do not log or expose them.
- The Windows build requires `vcvars64`. The Rust toolchain on `C:` can be corrupted by Windows
  Defender — prefer building from `D:`.
- Local data: `%APPDATA%/Alethe/` (profiles, `projects.json`, scrollback `*.bin`, `spawn.log`).

## 9. Going deeper

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
- [`docs/THEMES.md`](docs/THEMES.md), [`docs/UI_VISUAL_STYLES.md`](docs/UI_VISUAL_STYLES.md) —
  theming and the two sidebar visual styles (Normal/Clean).
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

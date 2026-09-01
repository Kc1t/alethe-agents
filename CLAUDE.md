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
- `docs/` — versioned docs (`FEATURES.md`, `CHANGELOG.md`, `OVERVIEW.md`, `BRAND.md`,
  `DIAGNOSTICO_MATURIDADE_TECNICA.md`).
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
- [`docs/DIAGNOSTICO_MATURIDADE_TECNICA.md`](docs/DIAGNOSTICO_MATURIDADE_TECNICA.md) — diagnostic of
  code organization, duplication, and performance, with prioritized recommendations.

The domain glossary (Group, Project, Container, Pane, Sub-tab, PTY) is summarized in `CONTRIBUTING.md`.

## graphify

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

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Universal across the 3 agent providers Alethe spawns (Claude Code, Codex, OpenCode) when the project has Graphify enabled: each gets the Graphify MCP server wired into its session automatically (Claude via `--mcp-config`; Codex/OpenCode via `.codex/config.toml`/`opencode.json` in the project root — see `graphify_codex_config_write`/`graphify_opencode_config_write` in `src-tauri/src/graphify.rs`).

Rules:
- If a Graphify MCP tool (e.g. `graphify_query`/similar) is available in this session, prefer calling it directly over shelling out — same scoped-subgraph result, no extra process spawn.
- Otherwise, for codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

# Alethe — working guide (AI)

> Identical in content to [`AGENTS.md`](AGENTS.md) in this directory. Keep both in sync.
> Contributing from outside? Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, project
> layout, house rules, and PR convention.

> **This repository is the macOS version of Alethe.** The native app lives in `AletheNative/`. The Windows and Linux
> app (Tauri, Rust, React) is a separate repository, [Kc1t/alethe-agents](https://github.com/Kc1t/alethe-agents), and
> is the **baseline** this app follows; `src/` and `src-tauri/` here are a reference snapshot of it, and
> Windows/Linux work belongs in that repository. Sections 2, 4 and 5 describe the baseline app; the rules in section 3
> apply here too, except the web-only ones (the dev server, and the `main` / `mac-native-v2` / `fork` branch policy of
> the baseline repository). In this repository `main` is the Mac app's main branch; "never push without explicit
> authorization" and "no co-author lines" still apply.

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
npm test         # vitest run over tests/**/*.test.ts (test:node runs via node --test, separately)
```

**Building the Windows installer (MSI/NSIS)** requires the MSVC environment (`vcvars64`):

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >NUL && npm run tauri build'
```

When returning the path of a generated installer, always report the **full absolute path on the PC**
(for example, `D:\project\src-tauri\target\release\bundle\nsis\Alethe_setup.exe`), never just the
path relative to the repository.



## 3. Non-negotiable rules

1. **DO NOT stop or restart the app or the dev server** (`tauri dev` / Vite). Do not kill the
   process, do not run `npm run app` "just to test" if it is already running. Apply changes through
   **HMR** and trust the reload.
2. **Commits are allowed ONLY as checkpoints** (to avoid losing work) and **only on the
   macOS-native migration branches** (e.g. `mac-native-v2`) — `main`, release branches and every
   other branch are read-only: never modify, commit to, rebase, merge or open a PR against them.
   **NEVER push / tag / release without explicit authorization from the owner at that moment.**
   Authorized pushes of `mac-native-v2` go to the `fork` remote (`HayatoG/alethe-agents`), never
   to `origin` — see [`docs/FORK_WORKFLOW.md`](docs/FORK_WORKFLOW.md).
   Commit messages carry **NO co-author** (`Co-Authored-By: Claude …`) or any tool signature — he
   is the only author.
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
6. **Task workflow order is fixed.** For every task, follow this order — never skip or
   reorder steps: **1. Implement → 2. Test → 3. Validate → 4. Update docs + ai-memory →
   5. Commit → 6. Start the next task.** One task per commit; the next task only starts after the
   previous one is committed. Backlog runs (e.g. the native macOS plan,
   [`docs/MAC_NATIVE_V2_PLAN.md`](docs/MAC_NATIVE_V2_PLAN.md)) process tasks one at a time this
   way, ticking the task's checkbox in the same commit.
7. **Docs and ai-memory are updated after every piece of work.** Whenever you do something —
   implement, fix, decide, investigate, or change a plan — update the affected versioned docs in
   the same task (plan/backlog checkboxes and parity matrix, architecture decisions, changelog,
   feature docs) **and** record the outcome in ai-memory (decisions, state of the work, gotchas,
   next steps) following the ai-memory skills. Work is not finished while either is stale.
8. **Every Mac divergence is registered.** The Windows/Linux app is the baseline (remote `upstream`, last reviewed
   commit in `AletheNative/UPSTREAM_BASELINE`). Anything the Mac app has that the baseline lacks, or does differently
   on purpose — a feature, setting, shortcut, default, ordering, wording, confirmation, limit or persisted field — is a
   *divergence*. Register it in [`AletheNative/DIVERGENCES.md`](AletheNative/DIVERGENCES.md) **in the same commit**
   that introduces it (next free `MD-nnn`, every column filled), and tag the matching `AletheNative/CHANGELOG.md`
   bullet `[Mac-only]` or `[Mac-different]` with that id. Parity is the default: never change baseline behavior
   silently, even to improve it; if it is not plainly a Mac idiom, ask the owner first. A persisted-shape addition must
   be optional, additive, ignored by the baseline's import/export and covered by a round-trip test. When the baseline
   catches up, mark the row `Converged` and drop the redundant Mac code; when the Mac feature should reach
   Windows/Linux, mark it `Propose to web` and build it in the other repository. `AletheNative/Scripts/check-divergences.py`
   (run by `test.sh`) keeps the registry well formed but cannot spot a missing row — in review, always ask: *does this
   give the Mac something the baseline lacks, or make it behave differently?*

## 4. Architecture at a glance

**Communication:** the frontend calls `invoke(...)` through `lib/tauri/`; the terminal receives
streaming through the Tauri events `pty://data/{id}` and `pty://exit/{id}`.

## 5. Conventions

- One `.module.css` file per component; color/spacing always through tokens, never literals.
- New domain types go in `src/lib/types.ts`; reuse the existing ones.
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
- **Native macOS app (`AletheNative/`, branch `mac-native-v2`)** — see
  [`docs/MAC_NATIVE_V2_PLAN.md`](docs/MAC_NATIVE_V2_PLAN.md):
  - Build/test with `AletheNative/Scripts/build.sh`, `test.sh` (strings gate + unit tests + build) and
    `uitest.sh` (hit-target harness). `Vendor/ghostty/build.sh` generates `Vendor/GhosttyKit`
    (needs Zig 0.16 and `xcodebuild -downloadComponent MetalToolchain`).
  - UI zoom scales metrics (`Metrics.scale`), never `scaleEffect`. After UI changes run `uitest.sh`.
  - Never drive the app with global keystrokes (System Events): they land in whatever window has
    focus. Use `AletheNative/Scripts/dev/keypost.swift` (posts to the app's process only) or the
    debug spike hooks.
  - Ghostty's keybinds are cleared (`keybind = clear`); app shortcuts live in the menus (ADR-10).
  - Signing: never pass `CODE_SIGN_IDENTITY` to `xcodebuild`; the app reads `ALETHE_SIGN_IDENTITY`
    (a self-signed identity also forbids separately signed dylibs: `ENABLE_DEBUG_DYLIB = NO`).
  - macOS 27 can ask CoreUI for an SF Symbol at 0×0 mid-animation (hidden toolbar hosts, sidebar rows
    expanding from zero height); CoreUI asserts and the app crashes. `SymbolRenderingGuard.install()`
    (`CAletheGlyphGuard`) must stay the first call in `AletheApp.init`. Keep toolbar labels' content
    fixed (one image; state via tint), since a swapped label can be laid out at 0×0 and vanish.
  - Packaging: `Scripts/make-dmg.sh [--skip-build]` builds `build/Alethe-macOS-universal.dmg` with the
    branded install window (`Scripts/dmg/`, dmgbuild in `build/dmg-venv`). The app icon comes from
    `Scripts/make-app-icon.py` on Apple's 824/1024 grid; the runtime Dock icon (`AppIcon.swift`)
    follows the same grid. Publishing a preview: `docs/FORK_WORKFLOW.md`.
  - Baseline: add the remote once with `git remote add upstream https://github.com/Kc1t/alethe-agents.git`, read
    its files with `git show upstream/main:<path>`, and triage its changes with
    `AletheNative/Scripts/upstream-watch.py --remote upstream` (plan §9). Divergences from it live in
    `AletheNative/DIVERGENCES.md` (rule 8).

## 7. Going deeper

Versioned in this repo:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup per OS, layout, house rules, commit/PR convention.
- [`docs/FEATURES.md`](docs/FEATURES.md) — features in detail.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — user-facing history.
- [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — domain model (Group, Project, Container, Pane, Terminal,
  Sub-tab, PTY), stack, and persistence.
- [`docs/BRAND.md`](docs/BRAND.md).
- [`docs/PLUGINS.md`](docs/PLUGINS.md) — plugin system: manifest, capabilities, lifecycle, and how
  to add a bundled plugin.
- [`docs/THEMES.md`](docs/THEMES.md) — adding a theme, as a plugin or as a built-in.
- [`docs/MAC_NATIVE_V2_PLAN.md`](docs/MAC_NATIVE_V2_PLAN.md) — native macOS (Swift) rewrite: decisions,
  phases/backlog, parity matrix, upstream tracking.
- [`AletheNative/DIVERGENCES.md`](AletheNative/DIVERGENCES.md) — the registry of everything the Mac app has or does
  differently from the Windows/Linux baseline (rule 8).
- [`docs/DIAGNOSTICO_MATURIDADE_TECNICA.md`](docs/DIAGNOSTICO_MATURIDADE_TECNICA.md) — diagnostic of
  code organization, duplication, and performance, with prioritized recommendations.

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

This project has a knowledge graph at `graphify-out/`. For codebase-structure questions
(architecture, god nodes, cross-file relationships), use the `graphify-query` skill instead of
raw grep/source browsing.

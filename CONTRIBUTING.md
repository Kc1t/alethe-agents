# Contributing to Alethe

Thanks for being here. Alethe is a small project with a real user base, and outside
contributions have shipped some of its best features — the in-app updater, mouse scroll inside
TUIs, Linux CLI detection, the Git diff explorer. Yours can be next.

This guide is written so you can go from `git clone` to an open pull request without having to
ask anyone anything. If a step here doesn't work, that's a bug in this document — please
[open an issue](https://github.com/Kc1t/alethe-agents/issues/new?labels=documentation) and say so.

**Language:** the codebase, docs, and commit messages are in English. Issues and pull request
descriptions in **English or Portuguese are both fine** — write in whichever you think clearly.
Nobody will be turned away over language.

---

## Table of contents

- [Ways to help](#ways-to-help)
- [Before you write code](#before-you-write-code)
- [Setting up](#setting-up)
- [Verifying your setup](#verifying-your-setup)
- [How the project is laid out](#how-the-project-is-laid-out)
- [House rules](#house-rules)
- [Commits and pull requests](#commits-and-pull-requests)
- [What happens after you open a PR](#what-happens-after-you-open-a-pr)
- [Troubleshooting](#troubleshooting)

---

## Ways to help

Roughly ordered from "you can do this today" to "talk to us first":

1. **Pick a [`good first issue`](https://github.com/Kc1t/alethe-agents/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).**
   These are scoped on purpose: the file is named, the expected result is described, and you
   don't need to understand the whole app to finish one.
2. **Report a bug** with steps to reproduce, your OS, and the app version. A good bug report is
   a real contribution — several fixes here started as one.
3. **Validate a platform.** Alethe is Windows-first and still under-tested on Linux and macOS.
   Running it on your machine and reporting exactly what broke is genuinely useful.
4. **Improve docs, screenshots, or setup notes.** If something confused you during setup, you're
   the best-positioned person in the world to fix it. See the [theme guide](docs/THEMES.md) for adding or documenting themes.
5. **Pick a [`help wanted`](https://github.com/Kc1t/alethe-agents/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issue.**
   Bigger, less hand-held, still well-defined.
6. **Propose a feature.** Open an issue describing the *workflow* it would improve before writing
   code — it's the cheapest way to avoid building something that won't be merged.

> For anything larger than a bug fix, open an issue first so the direction can be agreed on
> before you spend your evening on it.

## Before you write code

**Claim the issue.** Comment on it saying you're taking it. This is the whole process — no
assignment ritual, no waiting for approval. It exists so two people don't independently fix the
same thing on a Saturday.

If you claim something and life happens, just say so on the issue. No hard feelings, and it goes
back in the pool.

## Setting up

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | 20 LTS or newer recommended. CI runs `lts/*`. |
| **Rust (stable)** | Install via [rustup](https://rustup.rs). |
| **Platform toolchain** | See per-OS notes below. |

**Windows** — install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
with the *Desktop development with C++* workload (this gives you MSVC, which Rust links against).

**Linux** — install the Tauri system dependencies:

```sh
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

**macOS** — install Xcode Command Line Tools: `xcode-select --install`.

### Clone and run

```sh
git clone https://github.com/Kc1t/alethe-agents.git
cd alethe-agents
npm install
npm run app
```

`npm run app` runs the full desktop app (Tauri + Vite) with hot reload. **This is the command you
want** for almost all work.

The first `npm run app` compiles the Rust backend from scratch and takes several minutes. That is
normal and it is not stuck. Subsequent runs are fast.

### Working on the UI only

```sh
npm run dev   # frontend only, at http://localhost:1422
```

Useful for pure styling work, but anything that calls the backend (terminals, projects, sessions
— i.e. most of the app) will fail here, because there's no Tauri IPC in a plain browser. When in
doubt, use `npm run app`.

## Verifying your setup

Run these before you start, so you know a later failure is *your* change and not your environment:

```sh
npm test           # unit tests (vitest)
npm run build      # tsc typecheck + vite build
npm run lint       # eslint
npm run format     # prettier, writes in place
```

Rust side:

```sh
npm run test:rust  # cargo test --lib
```

CI runs the frontend tests, the typecheck/build, and `cargo check` + `cargo test` on Windows,
Linux, and macOS. If those four commands pass locally, CI will almost certainly be green.

> `npm run build` also **validates translations** — see [House rules](#house-rules). A missing
> `pt-BR` key is a type error, not a runtime surprise.

### Writing tests

There is exactly **one** test runner: Vitest, via `npm test`. Every test file is **colocated**
next to the module it covers — `src/lib/foo.ts` → `src/lib/foo.test.ts`,
`src/components/Bar/baz.ts` → `src/components/Bar/baz.test.ts`. There is no separate `tests/`
directory and no second runner. `vitest.config.ts` picks up any `src/**/*.{test,spec}.{ts,tsx}`
automatically — no per-file registration needed.

This used to be two parallel suites: colocated `src/**/*.test.ts` (Vitest) and a `tests/` directory
run separately via `node --test` (`npm run test:node`). CI only ever wired up `npm test`, so the
`tests/` suite silently stopped being checked on every push/PR. Two files ended up duplicated in
both places and drifted apart — one pair (`spawnQueue`, `sessionDiscovery`) had the `tests/`
version asserting behavior the source no longer had, and nobody noticed because CI was green
regardless. The suites were merged back into one in August 2026; when adding a test for pure logic
(no DOM), just colocate it like everything else — Vitest handles logic-only tests fine without extra
setup.

## How the project is laid out

```text
src/                  React 18 + TypeScript frontend
  components/         UI by feature; one .module.css per component
  stores/             Zustand — projectsStore (persisted), uiStore (ephemeral)
  hooks/              Shared React hooks
  lib/                Pure logic, no React. Best place to start reading.
    tauri.ts          Every backend `invoke` call goes through here
    types.ts          Domain types (Project, Group, Terminal, GridLayout…)
    i18n/             messages/en.ts (source of truth) + messages/pt-BR.ts
  styles/theme.css    Design tokens for all 12 themes

src-tauri/src/        Rust + Tauri backend
  lib.rs              Command registry (#[tauri::command] handlers)
  pty.rs              PTY spawn/attach/write/resize/kill + scrollback on disk
  projects.rs         Atomic load/save of projects.json
  cli_resolver.rs     Discovers installed CLIs (shells, Node managers, editors)

docs/                 Feature docs, changelog, brand
```

**Vocabulary** (worth internalizing before touching workspace/layout code):

- **Project** — a saved working context: terminals, layout, color, local state.
- **Group** — a set of projects opened, collapsed, or suspended together.
- **Container** — the visible frame of an opened project.
- **Pane** — a terminal view inside a container.
- **Sub-tab** — a separate shell or agent session inside the same pane.
- **PTY** — the real backend process, which keeps running even when the UI changes.

The frontend talks to the backend through `invoke(...)` in `lib/tauri.ts`. Terminal output
streams back as Tauri events: `pty://data/{id}` and `pty://exit/{id}`.

## House rules

These five come up in review more than anything else. Following them makes your PR boring to
merge, which is exactly what you want.

**1. Every visible string goes through `t()`.**
Add the key to `src/lib/i18n/messages/en.ts` (source of truth) **and**
`src/lib/i18n/messages/pt-BR.ts`. `pt-BR.ts` is typed against `en.ts`, so a missing translation
fails `npm run build`. Never hardcode user-facing text in a component.

**2. Colors and spacing come from tokens — never literals.**
Use the CSS custom properties in `src/styles/theme.css` (`--bg`, `--fg`, `--accent`, `--border`,
`--status-working`, …). Alethe ships 12 themes; a hardcoded `#10b981` looks right in dark mode and
wrong in the other eleven. No gradients.

**3. One `.module.css` per component.**
CSS Modules + custom properties. No Tailwind, no styled-components, no global styles.

**4. Feature changes update the changelog.**
Any feature added, changed, or removed gets a short, user-facing line in
[`docs/CHANGELOG.md`](docs/CHANGELOG.md) under the `[Não lançado]` section at the top. Release
notes are generated from it. Pure bug fixes and refactors don't need an entry.

**5. Reuse the domain types.**
New domain types go in `src/lib/types.ts`. Check what's there before defining a near-duplicate.

A few more, less often hit:

- Zustand selectors should be narrow — broad selectors cause rerender loops.
- `projects.json` is written debounced and atomically (tmp → rename). Preserve that.
- The `projects.json` schema is versioned with migrations. If you change its shape, add the
  migration in `src/stores/projectsStore.migrations.ts`.
- `spawn_pty` runs a shell with a command and args coming from the frontend. Validate input on
  the frontend before spawning; treat anything rendered from disk or the network as untrusted.

## Commits and pull requests

**Branch** off `main`: `fix/terminal-scroll-wheel`, `feat/cli-open-project`, `docs/linux-setup`.

**Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org):

```text
fix(terminal): restore mouse scroll inside TUI alternate screen
feat(cli): add Linux CLI detection fallback via which crate
docs: add Linux setup notes
```

**Keep the PR focused.** One concern per pull request. A drive-by reformat of an unrelated file
turns a five-minute review into a thirty-minute one, and reviewer attention is the scarcest
resource in this project.

**In the PR description**, include:

- What changed and why, in a couple of sentences.
- `Closes #123` if it resolves an issue.
- **Before/after screenshots or a GIF for any UI change.** Not optional — Alethe is a visual app
  and this is often the fastest way to get a yes.
- Which OS you tested on. "Windows only, untested on macOS" is a perfectly good thing to write,
  and far better than silence.

Run `npm run format` before pushing.

## What happens after you open a PR

CI runs the frontend build and tests plus `cargo check`/`cargo test` on all three platforms. Get
it green — a red PR usually just waits.

Review is done by the maintainer ([@Kc1t](https://github.com/Kc1t)), who works on this alongside a
full-time job. Expect a first response within a few days. If a week goes by with nothing, a polite
bump on the PR is welcome and not annoying.

Review comments are about the code, never about you. Feel free to push back if you disagree —
you may well be right, and "I did it this way because X" is a valid answer.

Once merged, you're added to the contributors wall in the README automatically (there's a workflow
for it — you don't have to do anything).

## Troubleshooting

**Windows Defender deletes the binary you just built.**
Alethe spawns processes and creates PTYs from an unsigned binary, which trips Defender's ML
heuristic (`Trojan:Win32/Bearfoos.A!ml`). It's a false positive. Add an exclusion for
`src-tauri/target` — otherwise your dev builds get quarantined mid-work. See the README for
details.

**The Rust build fails on Windows with linker errors.**
You're missing MSVC. Install the Visual Studio Build Tools "Desktop development with C++"
workload. For a full installer build you may need to run from a `vcvars64` shell.

**`npm run build` fails with a type error in `pt-BR.ts`.**
You added an i18n key to `en.ts` and not to `pt-BR.ts`. That's rule 1 — this failure is the guard
rail working as designed.

**`npm run dev` opens, but terminals and projects don't work.**
Expected. The browser has no Tauri IPC. Use `npm run app`.

**The first build takes forever.**
The Rust backend compiles from scratch the first time. Grab a coffee; it's cached afterward.

---

## License

Alethe is licensed under **AGPL-3.0-or-later**. By contributing, you agree that your contribution
is licensed under the same terms. The **Alethe** name, logo, and branding are reserved for
official builds — see [`TRADEMARK.md`](TRADEMARK.md).

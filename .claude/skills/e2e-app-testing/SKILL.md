---
name: e2e-app-testing
description: Real click/typing WebdriverIO e2e toolkit for the Alethe desktop app — use whenever the user asks to test, explore, click through, or verify a feature in the running Alethe UI (not unit/Rust tests). Covers generic navigation tools, a saved-procedure registry, and the specific flows already mapped (onboarding, project creation, git init, agent/merge settings).
---

# Testing Alethe via real e2e (WebdriverIO)

This skill exists so that **any Claude Code session** (not just the one that wrote it) can
test the app by really clicking/typing in the UI, without needing to rediscover from scratch how
the test environment works. See the full history in `docs/CHANGELOG.md` (the "Tests" section) and
in the comments of each file cited below — this is just the map of "what exists and how to use it."

## Golden rule: real clicks, never hooks for actions

Every test in this suite interacts with the real UI via WebDriver click/typing — **never** via
`window.__ALETHE_E2E__` to trigger an action (create project, open terminal, etc.). That hook
exists only to **read** state the UI already created (`window.__ALETHE_E2E_QUERY__`,
`window.__ALETHE_E2E_STORE_DEBUG__`) — never for actions. Reason: a hook can "work" even with
the real on-screen button broken, masking real UI bugs (it has already happened in this suite more
than once — see CHANGELOG).

## Before running anything

1. **Never run any test without isolation** — `e2e/support/launch.ts` already takes care of this via
   `ALETHE_APP_DATA_DIR` (a fully isolated profile from the user's real profile, created from scratch
   on every run). Never bypass this.
2. **If anything in `src/**` changed since the last build**, rebuild both stages before running
   e2e, otherwise the test silently runs against stale code:
   ```powershell
   npm_config_script_shell=cmd npm run build
   CARGO_TARGET_DIR=target-e2e npm_config_script_shell=cmd npx tauri build --debug --no-bundle
   ```
3. **Check for stuck processes** before rebuilding (`Get-Process alethe`) — only kill whatever is
   at `target-e2e\debug\alethe.exe`; the process at `target\debug\alethe.exe` is the user's real
   app (`npm run app`), NEVER touch it.
4. Running a spec: `npx wdio run e2e/wdio.conf.ts --spec e2e/specs/<file>.spec.ts`. Run it in the
   FOREGROUND (without redirecting to background) if the user wants to watch the window
   live — moving it to background puts the window in a session without an interactive desktop,
   invisible to them (a real bug already diagnosed in this session).

## Available tools (from most generic to most specific)

### `e2e/support/uiKit.ts` — generic, for any screen

- `clickByText(text, opts?)` — clicks ANY button/link/`[role=button]` whose visible text
  (or `aria-label`/`title`, for icon-only buttons) contains `text`. Takes a screenshot with a red marker
  BEFORE clicking, always. Use `scopeSelector`/`index` if the text is ambiguous on screen.
- `typeIntoByPlaceholder(placeholder, value)` / `typeIntoBySelector(selector, value)` — types
  directly into the field. **`typePath(placeholder, path)`** is the same helper with an explicit name for
  path fields — use it ALWAYS when you need to fill in a path, and NEVER click the "Browse"
  button next to it (it opens Windows' NATIVE folder picker, outside the webview — WebDriver can't
  see or close that window, which hangs the entire session). Every path field in this app
  accepts direct typing into the `<input>`, with no known exception so far.
- `waitForText(text)` / `waitForTextGone(text)` — confirms that something appeared/disappeared from the screen.
- `acceptAlertIfPresent(timeout?)` — accepts a native `confirm()`/`alert()` if it appears, without
  failing if it doesn't.
- `snapshot(label)` — standalone screenshot, without a marker, just to record a state.
- `dragBy(selector, { deltaX, deltaY, steps, stepDurationMs, repetitions, repetitionPauseMs })` —
  precise drag via the W3C Actions API (not an instant "drop" — gradual movement in `steps`
  increments, because some resize handlers only fire with real movement). `deltaX`/`deltaY`
  relative to the element's center (positive = right/down). `repetitions` repeats the whole drag
  N times. Useful for resizing panels by dragging the divider.
- `dragFromTo(fromSelector, toSelector, { steps, stepDurationMs })` — same thing, but to another
  element instead of a computed delta.
- `scrollIntoView(selector)` — scrolls an element into the visible area before checking/clicking.
- `scrollBy(deltaX, deltaY, { selector? })` — scrolls the page (or a specific container) via a real wheel
  action (not `scrollTop` directly — some components with virtualized scrolling only react
  to a real wheel). Positive `deltaY` scrolls down, negative up; positive `deltaX` goes right.
- `withIdleScreenshot(label, fn, idleMs=5000)` — runs `fn()` and takes an automatic screenshot if it doesn't
  resolve within `idleMs` (default 5s), BEFORE continuing to wait — it doesn't cancel `fn()`, it just captures
  the screen state at the moment something is slower than expected. Use it on any wait
  that might hang (native confirm(), an element that takes a while to appear) so there's always a screenshot of the
  exact moment right before a possible failure, without having to guess where to place `snapshot()`.

### `e2e/support/procedures.ts` + `procedures.json` — already-discovered paths, saved

Named registry of step sequences (`ProcedureStep[]`) persisted in JSON — record a
navigation path once, repeat it later without re-deriving it:
- `runProcedure(name)` — runs a saved procedure.
- `saveProcedure(name, steps)` — saves (or overwrites) a new one. Supported steps:
  `click`/`type`/`waitText`/`waitTextGone`/`acceptAlert`/`snapshot`/`drag`/`dragTo`/
  `scrollIntoView`/`scrollBy` (same parameters as the equivalent functions in `uiKit.ts`).
- `listProcedures()` — lists the already-saved names.
- Already comes with `openProjectSettingsAgentsTab`, `openProjectSettingsMergeTab`,
  `closeProjectSettings` pre-recorded (see `procedures.json`) — expand this list whenever you
  discover a new path worth reusing.

### `e2e/specs/_sandbox.spec.ts` — ad-hoc exploration

Disposable spec, rewritten on every exploration — it's not a regression test for anything. Already imports
`quickLogin` + everything from `uiKit.ts`/`procedures.ts`. Freely edit the body of `it()`.

### `e2e/support/onboardingFlow.ts` — "login"

`quickLogin(displayName)` (= `completeOnboarding`) — goes through the profile creation screen if it
appears; **idempotent**, doesn't hang if the profile already exists (the profile is reused between specs).
Call it at the start of ANY new spec, always — every e2e profile starts empty.

### `e2e/support/projectUi.ts` — specific flows already mapped, more precise

Prefer these over a loose `clickByText` when the flow is already here — better shielded against
known collisions (e.g. the same "OpenCode" label exists on different screens):
`createProjectViaUi`, `initGitViaUi`, `selectConflictAgentAndAutoWorktreeViaUi`,
`migrateExistingTerminalsViaUi`, `selectMergePostActionAndSaveViaUi`, `openAgentTerminalViaUi`,
`completeAutoOpenedNewTerminalModal`, `findProjectId`, `findLatestTerminal`,
`getConflictAgentProvider`.

### `e2e/support/ptyAgent.ts` — direct backend calls (deliberate exception)

`invokeTauri(cmd, args)` calls Rust commands directly via `window.__TAURI_INTERNALS__.invoke` — used
ONLY for operations that have no equivalent clickable UI action (low-level git/worktree/merge) or
where going through the UI would make the test non-deterministic (e.g. AI conflict resolution). Never
use this for something that DOES have a real button — that's when you use `clickByText`/`projectUi.ts`.

## Real gotchas already diagnosed (don't repeat the investigation)

- Windows' native folder dialog (`pickDirectory`) hangs WebDriver — always type, never
  click "Browse".
- `browser.execute()` with an ELEMENT reference as an argument hangs for ~30s (a
  `@wdio/tauri-service` bug) — `markAndScreenshot` uses `getLocation()`/`getSize()` (native
  commands) and only passes numbers to `execute()`, never the element itself.
- Native `confirm()`/`alert()` dialogs sometimes don't register on the first click — `clickAndAcceptConfirm`
  in `projectUi.ts` already re-clicks once before giving up.
- The "Agents" tab in Settings has TWO agent selectors with the SAME labels (the
  "New terminal" card and the "Conflict resolution agent" card) — always confirm
  which modal/tab you're in before clicking by loose text.
- **REAL DANGER**: an unscoped `[aria-label="Fechar"]` (Close) matches both the button that closes a MODAL and
  the button that **closes the ENTIRE APP WINDOW** in the top bar (same aria-label on both!). A click
  that "leaked" to that button would really close the app mid-test. Confirmed live
  (it only didn't close by luck — the modal overlay blocked the click). ALWAYS scope it:
  `$('[role="dialog"] button[aria-label="Fechar"]')` or `clickByText('Fechar', { scopeSelector:
  '[role="dialog"]' })`, never a bare `[aria-label="Fechar"]` on the whole page.
- "Starting a real agent terminal (`completeAutoOpenedNewTerminalModal`) BEFORE
  `initGitViaUi()` can cause the folder to become a Git repository on its own — some agents (e.g.
  OpenCode) run `git init` on their own when launched in a new folder. `initGitViaUi()` already handles
  this (skips the banner if it doesn't exist) — don't assume a "just created" folder still
  doesn't have `.git` after a real agent terminal has already been opened in it.
- Running a background command (>180s) removes the window from a session with an interactive desktop —
  invisible to the user even though the process is alive. Prefer foreground when they want to watch it.
- **Known limitation, still unsolved**: clicking an option in a `Dropdown.tsx` menu
  (`createPortal` directly into `document.body` — e.g. "Git Control Location" in Preferences →
  Appearance) can fail with `element click intercepted... Other element would receive the click:
  <h2>` at the SAME pixel point, consistently and reproducibly — it's not a race condition
  (retrying with a pause doesn't fix it, tested live). Likely a systematic misalignment between the
  coordinate WebDriver measures and where the click actually lands in this embedded WebView2
  (possibly DPI/zoom-related). Still unresolved — if you need to change a preference like this, consider
  first finding/using the API/store directly to READ the confirmation, or investigating further
  before assuming `clickByText` always works for this type of menu.

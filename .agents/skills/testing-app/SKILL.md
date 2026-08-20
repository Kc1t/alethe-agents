---
name: testing-app
description: Use when running, authoring, debugging, or validating tests across any layer of the Alethe application (frontend unit tests, Rust backend tests, TypeScript/i18n checks, or WebdriverIO E2E UI suites).
---

# Testing the Alethe Application

## Overview

Alethe is a desktop-first multi-agent workspace built with React (frontend), Rust/Tauri (backend), and standalone sync servers. Quality is enforced through a strict multi-layer testing pyramid ranging from static type and i18n contract validation to full-stack WebdriverIO end-to-end tests interacting with real desktop windows.

## When to Use

Use this skill whenever you need to:
- Validate changes before submitting a PR or finishing a feature branch.
- Run or write unit tests for frontend stores, hooks, parsers, or components.
- Run or write Rust backend unit tests, contract checks, or PTY tests.
- Execute full desktop E2E flows (onboarding, project creation, Git pipelines, conflict resolution).
- Test multi-client synchronization between desktop and `alethe-server`.
- Investigate test failures, race conditions, or UI interaction bugs.

**When NOT to use:**
- For manual code reviews without testing intention (use `requesting-code-review`).
- For general agent workflows unrelated to test execution.

---

## Test Layers & Quick Reference

| Layer | Command | Primary Scope / Focus | When to Run |
|---|---|---|---|
| **1. Static & i18n** | `npm run build` | Typechecking (`tsc`) + i18n parity + bundle | Every code change |
| **1b. Lint & Format** | `npm run lint`<br>`npm run format:check` | ESLint rules & Prettier formatting | Before committing |
| **2. Frontend Unit** | `npm test` (`vitest run`) | Zustand stores, utilities, components | Unit/logic modifications |
| **3. Rust Backend** | `npm run test:rust` | Rust backend commands, PTY, state, profiles | Rust changes in `src-tauri/` |
| **3b. Ghostty Bridge** | `npm run test:ghostty` | Terminal emulator & bridge tests | Ghostty/PTY changes |
| **4. E2E UI Suite** | `npm run test:e2e` | Real WebdriverIO clicks & typing on Tauri app | Feature/UI verification |
| **4b. Git Pipeline E2E**| `npm run test:e2e:git-pipeline` | Git init, worktrees, multi-agent merge flows | Git/agent workflow changes |
| **5. Web Sync E2E** | `npm run test:e2e:sync` | Desktop + `alethe-server` grid convergence | Sync & WebSocket changes |

---

## Layer 1: Static Checks, Linting & i18n Contract

### 1. TypeScript & i18n Parity
```powershell
npm run build
```
- Runs `tsc && vite build`.
- **i18n Contract Requirement:** `src/lib/i18n/messages/en.ts` is the single source of truth. `src/lib/i18n/messages/pt-BR.ts` is strictly typed against `en.ts`. If any translation key is missing or mistyped in `pt-BR.ts`, `tsc` fails immediately.

### 2. Linting & Formatting
```powershell
npm run lint
npm run format:check
```
- Enforces import sorting (`eslint-plugin-simple-import-sort`), React hooks rules, and consistent Prettier formatting.

---

## Layer 2: Frontend Unit & Component Tests (Vitest)

Vitest executes unit tests against `src/**/*.{test,spec}.{ts,tsx}` in a `jsdom` environment.

### Running Frontend Tests
```powershell
# Run all unit tests once
npm test

# Run a specific test file
npx vitest run src/stores/projectsStore.persistence.test.ts

# Run tests matching a pattern
npx vitest run agentLibrary
```

### Environment Caveats
- **LocalStorage in Node 22+:** Configured with `NODE_OPTIONS: '--no-experimental-webstorage'` in `vitest.config.ts` to prevent Node's experimental global `localStorage` from shadowing `jsdom`.
- **Zustand Persistence:** When testing stores, ensure state isolation between test cases (e.g., reset store states or clean mocks in `beforeEach`/`afterEach`).

---

## Layer 3: Backend Rust Unit & Contract Tests

Rust backend tests reside in `src-tauri/src/` (inline `#[cfg(test)]`) and integration tests in `src-tauri/tests/`.

### Running Rust Tests
```powershell
# Run all standard backend unit tests
npm run test:rust
# Equivalent to: cargo test --manifest-path src-tauri/Cargo.toml --lib

# Run a specific Rust test module or function
cargo test --manifest-path src-tauri/Cargo.toml --lib profiles::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib conflict_resolution

# Run integration contract tests
cargo test --manifest-path src-tauri/Cargo.toml --test profile_sync_contract

# Run ignored Ghostty terminal tests (single-threaded)
npm run test:ghostty
```

---

## Layer 4: End-to-End UI Testing (WebdriverIO + Tauri Service)

WebdriverIO interacts directly with the compiled desktop application through `@wdio/tauri-service` and `tauri-driver`.

### 1. Golden Rules for E2E Tests
1. **Real Clicks, Never Action Hooks:**
   - Interacting with UI MUST happen via real WebDriver clicks (`clickByText`, `clickBySelector`) and typing (`typeIntoByPlaceholder`, `typePath`).
   - `window.__ALETHE_E2E__` / `window.__ALETHE_E2E_QUERY__` / `window.__ALETHE_E2E_STORE_DEBUG__` are strictly **read-only** for state verification, NEVER for triggering actions (opening modals, creating projects, dispatching events).
2. **Strict Profile Isolation:**
   - E2E runs use `ALETHE_APP_DATA_DIR` pointing to a clean temporary directory (`mkdtempSync`).
   - NEVER touch or rely on `%LOCALAPPDATA%\Alethe` (user's real profile).
3. **Build Target Separation:**
   - E2E tests compile into `src-tauri/target-e2e/debug/alethe.exe` using `CARGO_TARGET_DIR=target-e2e`.
   - Never kill or interfere with `target\debug\alethe.exe` (user's active `tauri dev` instance).

### 2. Building for E2E
Before running E2E tests, rebuild if frontend or backend code changed:
```powershell
# In PowerShell / Windows:
$env:npm_config_script_shell="cmd"; npm run build
$env:CARGO_TARGET_DIR="target-e2e"; $env:npm_config_script_shell="cmd"; npx tauri build --debug --no-bundle
```
Or use the npm script:
```powershell
npm run test:e2e:build
```

### 3. Running Specs
```powershell
# Run the entire E2E test suite
npm run test:e2e

# Run a specific spec
npx wdio run e2e/wdio.conf.ts --spec e2e/specs/smoke.spec.ts
npx wdio run e2e/wdio.conf.ts --spec e2e/specs/onboarding.spec.ts
npx wdio run e2e/wdio.conf.ts --spec e2e/specs/git-pipeline.spec.ts

# Ad-hoc exploratory testing (edit e2e/specs/_sandbox.spec.ts first)
npx wdio run e2e/wdio.conf.ts --spec e2e/specs/_sandbox.spec.ts
```

> [!IMPORTANT]
> **Foreground Execution:** Run E2E tests in the foreground. Moving the execution to a non-interactive background process (>180s timeout) detaches the desktop session on Windows, making the window invisible.

### 4. E2E Tooling & Support Helpers

#### `e2e/support/uiKit.ts` (Universal UI interaction)
- `clickByText(text, opts?)`: Clicks any button, link, or `[role=button]` matching text or `aria-label`/`title`. Automatically captures red-marker screenshot before clicking.
- `typeIntoByPlaceholder(placeholder, value)` / `typeIntoBySelector(selector, value)`: Inputs text directly into fields.
- `typePath(placeholder, path)`: Explicit helper for folder inputs. **Always use this instead of clicking native "Procurar" buttons.**
- `waitForText(text, timeout?)` / `waitForTextGone(text, timeout?)`: Confirms UI text appearance/disappearance.
- `acceptAlertIfPresent(timeout?)`: Safely accepts native dialogs without throwing if absent.
- `dragBy(selector, { deltaX, deltaY, steps })` / `dragFromTo(fromSelector, toSelector)`: Smooth panel resizing via W3C Actions API.
- `snapshot(label)`: Captures clean visual snapshot.

#### `e2e/support/projectUi.ts` (High-level flows)
- `createProjectViaUi(name, path)`: Complete project creation flow.
- `initGitViaUi()`: Initializes Git repository through UI.
- `selectConflictAgentAndAutoWorktreeViaUi(provider)`: Configures conflict resolution provider.
- `openAgentTerminalViaUi(agentType)`: Opens agent terminal and waits for initial prompt.

#### `e2e/support/onboardingFlow.ts`
- `quickLogin(displayName)`: Idempotent onboarding bypass (creates profile if needed, no-op if already configured).

#### `e2e/support/procedures.ts` + `procedures.json`
- `runProcedure(name)`: Replays recorded multi-step UI paths (e.g. `openProjectSettingsAgentsTab`).
- `saveProcedure(name, steps)`: Persists reusable step sequences.

---

## Layer 5: Sync Server & Multi-Client E2E

Tests real-time state synchronization between the desktop app and the headless `alethe-server` web daemon sharing the same data root.

```powershell
# Build both binaries and run sync E2E
npm run test:e2e:sync:build
npm run test:e2e:sync
```

Validates terminal grid resize convergence (`cols`/`rows`) across desktop and web browser clients.

---

## Critical Gotchas & Troubleshooting

| Symptom / Gotcha | Root Cause | Solution |
|---|---|---|
| **WebDriver freezes when picking folder** | Native Windows folder dialog opened | Never click "Procurar" in E2E. Use `typePath(placeholder, path)` to type directly into the input. |
| **`target-e2e\debug\alethe.exe` locked / permission denied** | Zombie process from previous failed E2E run | Check `Get-Process alethe`. Kill ONLY processes residing in `target-e2e\debug\alethe.exe`. Never kill `target\debug\alethe.exe`. |
| **E2E tests passing against stale code** | Frontend or Tauri binary was not rebuilt | Run `npm run build` and `CARGO_TARGET_DIR=target-e2e tauri build --debug --no-bundle` before testing. |
| **`Dropdown.tsx` click intercepted** | Portal rendered at `document.body` with DPI/zoom mismatch | Use `window.visualViewport` coordinates or verify state changes via store/query hooks. |
| **`browser.execute()` hangs ~30s** | Passing a DOM element reference into `browser.execute()` | Bug in `@wdio/tauri-service`. Use native `getLocation()`/`getSize()` and pass only numeric coordinates to `execute()`. |
| **i18n build fails on `tsc`** | Key mismatch between `en.ts` and `pt-BR.ts` | Add missing keys to `src/lib/i18n/messages/pt-BR.ts` matching `en.ts`. |

---

## Rationalization Table

| Rationalization | Reality | Counter-Action |
|---|---|---|
| *"TypeScript compiled cleanly, so E2E isn't needed."* | Type safety does not test CSS layouts, IPC races, or button click handlers. | Run `npm test` and the relevant E2E spec. |
| *"I can trigger the action hook in `window.__ALETHE_E2E__` to make the test faster."* | Action hooks bypass real UI event listeners and mask broken buttons. | Use `clickByText` or `projectUi.ts` helpers. |
| *"I will test all flows manually in the dev server."* | Manual testing is non-repeatable and doesn't verify isolated profile creation. | Automate exploratory steps in `e2e/specs/_sandbox.spec.ts`. |
| *"Rust unit tests don't matter if Tauri compiles."* | Rust commands manage low-level PTY spawns and atomic file writes. | Run `npm run test:rust` whenever modifying `src-tauri/src/`. |

---

## Red Flags - STOP and Fix

- Calling `window.__ALETHE_E2E__` to perform state mutation or click actions.
- Modifying or deleting `%LOCALAPPDATA%\Alethe` directly during test runs.
- Killing all `alethe.exe` processes without filtering by executable path.
- Committing frontend changes without verifying `npm run build` (i18n parity check).
- Hardcoding file paths or assuming `D:\` drives in tests (use `fixtureProject.ts` and `tmpdir()`).

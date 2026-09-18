# Orchestration board nodes and inspector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put planner shells on the orchestration canvas as nodes connected to whoever opened them, and replace the in-canvas worker detail strip with an overlay panel that can also host a shell's live terminal.

**Architecture:** Layout and selection decisions live in pure, unit-tested helpers (`orchestratorGraph.ts`, `orchestratorShells.ts`, `orchestratorShortcuts.ts`); the pane and the new `OrchestratorInspector` component stay thin. The Rust core learns a generic shell owner (kind + id, backward-compatible with the stored `plannerId`) and exposes worker cancellation as a method both the MCP tool and a new Tauri command call.

**Tech Stack:** Rust (Tauri 2), React 18 + TypeScript, Zustand, CSS Modules with theme tokens, Vitest + Testing Library, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-16-orchestration-board-nodes-design.md`

## Global Constraints

- **Never commit, push or tag.** Leave work in the working tree and `git add` the files you touched at the end of each task. The owner commits himself. Never add co-author or tool-attribution trailers anywhere.
- **Never start, stop or restart the app** (`npm run app` / `tauri dev` / Vite). It is not running.
- English for all code, comments, docs and commit-less artifacts. Keep comments short and only where behaviour is non-obvious.
- Every visible string goes through `t()` and is registered in BOTH `src/lib/i18n/messages/en.ts` and `src/lib/i18n/messages/pt-BR.ts` (`npm run build` fails otherwise). Orchestrator keys live near `'orchestrator.shell.*'` (en.ts:1893, pt-BR.ts:1922).
- Styling: CSS Modules only, colors and spacing through the tokens in `src/styles/theme.css` (`--bg`, `--bg-elevated`, `--bg-sunken`, `--fg`, `--fg-muted`, `--border`, `--panel-hover`, `--status-working`, `--status-offline`, `--status-stopped`, `--font-mono`, `--anim-fast`). No gradients, no hardcoded colors.
- A separate, already-landed fix package touched `src-tauri/src/orchestrator_core.rs`, `src-tauri/src/orchestrator_shells.rs`, `src/components/OrchestratorPane/index.tsx` (the `PlannerTab` component), `src/lib/paneResume.ts` and `src/components/XTermView/useXtermSession.ts`. **Read the current file contents before editing; do not assume the line numbers in this plan are still exact.**
- Test commands: `npm test` (Vitest), `npm run build` (tsc + i18n parity), `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`. The orchestrator integration test prints two pre-existing `failed to delete ... worktrees/job-0X: Permission denied` lines on Windows; only the `test result:` line matters.

---

## File Structure

**Created**

- `src/lib/orchestratorShortcuts.ts` — shortcut types are in `types.ts`; this holds the built-ins, the visibility filter and the placeholder renderer.
- `src/lib/orchestratorShortcuts.test.ts`
- `src/components/OrchestratorPane/OrchestratorInspector.tsx` — the overlay panel: worker/subagent tabs and the shell terminal.
- `src/components/OrchestratorPane/OrchestratorInspector.module.css`
- `src/components/OrchestratorPane/OrchestratorInspector.test.tsx`
- `src/components/OrchestratorPane/ShellNode.tsx` + `ShellNode.module.css` — the compact canvas card (replaces `ShellCard`).
- `src/components/OrchestratorPane/ShellNode.test.tsx`

**Modified**

- `src-tauri/src/orchestrator_shells.rs` — `ShellOwner` / `ShellOwnerKind`, `Shell::owner`, record round-trip.
- `src-tauri/src/orchestrator_core.rs` — owner plumbing in `alethe_open_shell`; `Core::cancel_jobs` extracted from the `alethe_cancel` arm.
- `src-tauri/src/orchestrator.rs`, `src-tauri/src/lib.rs` — `orchestrator_cancel_job` command + registration.
- `src-tauri/tests/orchestrator.rs` — owner snapshot and cancel-through-method tests.
- `src/lib/tauri/orchestrator.ts` — `OrchestratorShellOwner`, `OrchestratorShell.owner`, `orchestratorCancelJob`.
- `src/lib/orchestratorShells.ts` (+ `.test.ts`) — owner-aware `shellsForBoard` returning `BoardShell`.
- `src/lib/orchestratorGraph.ts` (+ `orchestratorGraph.test.ts`) — `shellGroup` / `shell` node kinds and their layout.
- `src/lib/types.ts` — `OrchestratorShortcut`, `ShortcutRule`, `Preferences.orchestratorShortcuts`, default.
- `src/components/modals/preferences/MultiagentPage.tsx` (+ its module CSS) — the shortcuts editor.
- `src/components/OrchestratorPane/index.tsx` (+ `OrchestratorPane.module.css`) — render the new nodes, hover bars, inspector; delete the rail shells section and the worker detail strip.
- `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`.
- `docs/CHANGELOG.md`.

**Deleted**

- `src/components/OrchestratorPane/ShellCard.tsx`, `ShellCard.module.css`, `ShellCard.test.tsx` (superseded by `ShellNode`).

---

### Task 1: Shell owner in the core

**Files:**
- Modify: `src-tauri/src/orchestrator_shells.rs`
- Modify: `src-tauri/src/orchestrator_core.rs` (the `alethe_open_shell` arm and any `planner_id` use)
- Modify: `src-tauri/tests/orchestrator.rs`
- Modify: `src/lib/tauri/orchestrator.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ShellOwner { kind: ShellOwnerKind, id: String }`, `ShellOwnerKind::{Planner, Worker}`, `Shell.owner: Option<ShellOwner>`, snapshot field `"owner": { "kind": "planner", "id": "<ptyId>" } | null`; TS `OrchestratorShellOwner = { kind: 'planner' | 'worker'; id: string }` and `OrchestratorShell.owner: OrchestratorShellOwner | null` (the `plannerId` field is removed from both).

- [ ] **Step 1: Write the failing Rust tests**

In `src-tauri/src/orchestrator_shells.rs`, inside the existing `mod tests`, add:

```rust
    #[test]
    fn a_record_round_trips_its_owner() {
        let shell = sample();
        let restored = Shell::from_record(&shell.record()).expect("a shell");
        assert_eq!(
            restored.owner,
            Some(ShellOwner::planner("p1")),
            "the owner was lost on the way back"
        );
    }

    #[test]
    fn a_record_written_before_owners_reads_as_a_planner() {
        let legacy = json!({
            "id": "shell-01",
            "name": "npm",
            "command": "npm run dev",
            "cwd": "C:\\app",
            "plannerId": "p1",
            "status": "running",
            "exitCode": null,
            "startedAtMs": 0
        });
        let restored = Shell::from_record(&legacy).expect("a shell");
        assert_eq!(restored.owner, Some(ShellOwner::planner("p1")));
    }

    #[test]
    fn a_record_with_no_owner_at_all_reads_as_none() {
        let legacy = json!({ "id": "shell-01", "command": "npm run dev" });
        let restored = Shell::from_record(&legacy).expect("a shell");
        assert_eq!(restored.owner, None);
    }
```

Update the existing `sample()` helper: replace `planner_id: Some("p1".into())` with `owner: Some(ShellOwner::planner("p1"))`, and replace the existing `assert_eq!(restored.planner_id.as_deref(), Some("p1"));` in the round-trip test with `assert_eq!(restored.owner, Some(ShellOwner::planner("p1")));`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_shells`
Expected: FAIL — `cannot find type ShellOwner`, `no field owner on type Shell`.

- [ ] **Step 3: Add the owner type and field**

In `src-tauri/src/orchestrator_shells.rs`, above `pub struct Shell`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellOwnerKind {
    Planner,
    Worker,
}

impl ShellOwnerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planner => "planner",
            Self::Worker => "worker",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "planner" => Some(Self::Planner),
            "worker" => Some(Self::Worker),
            _ => None,
        }
    }
}

/// Who asked for this shell. Only planners can open one today; the kind is carried so a worker-owned
/// shell needs no change here or on the board.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellOwner {
    pub kind: ShellOwnerKind,
    pub id: String,
}

impl ShellOwner {
    pub fn planner(id: impl Into<String>) -> Self {
        Self { kind: ShellOwnerKind::Planner, id: id.into() }
    }

    pub fn to_value(&self) -> Value {
        json!({ "kind": self.kind.as_str(), "id": self.id })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let kind = ShellOwnerKind::parse(value.get("kind")?.as_str()?)?;
        let id = value.get("id")?.as_str()?;
        if id.is_empty() {
            return None;
        }
        Some(Self { kind, id: to_string_owned(id) })
    }
}

fn to_string_owned(value: &str) -> String {
    value.to_string()
}
```

(If a plain `.to_string()` reads better inline, drop `to_string_owned` and use it directly — do not keep both.)

In `pub struct Shell`, replace `pub planner_id: Option<String>,` with:

```rust
    /// Who opened it. `None` for a shell whose owner was never recorded.
    pub owner: Option<ShellOwner>,
```

- [ ] **Step 4: Emit and read the owner**

In `Shell::snapshot`, replace the `"plannerId": self.planner_id,` line with:

```rust
            "owner": self.owner.as_ref().map(ShellOwner::to_value),
```

In `Shell::from_record`, replace `planner_id: text("plannerId"),` with:

```rust
            // `plannerId` is what shells persisted before owners existed; it was always a planner.
            owner: value
                .get("owner")
                .and_then(ShellOwner::from_value)
                .or_else(|| text("plannerId").map(ShellOwner::planner)),
```

- [ ] **Step 5: Update the core's callers**

In `src-tauri/src/orchestrator_core.rs`, find every use of `planner_id` on a `Shell` (the `alethe_open_shell` arm builds one) and switch to the owner. Where the calling planner is known:

```rust
        owner: planner.map(ShellOwner::planner),
```

Add `ShellOwner` to the existing `pub use shells::{...}` re-export list so `orchestrator.rs` and the tests can name it.

- [ ] **Step 6: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_shells`
Expected: PASS, no warnings mentioning `orchestrator_shells.rs`.

- [ ] **Step 7: Add the integration assertion**

In `src-tauri/tests/orchestrator.rs`, find the existing test that opens a shell through `alethe_open_shell` and asserts on the snapshot. Add to it:

```rust
    let shell = &core.snapshot()["shells"][0];
    assert_eq!(shell["owner"]["kind"], json!("planner"), "{shell}");
    assert_eq!(shell["owner"]["id"], json!("planner-1"), "{shell}");
```

using whatever planner id that test already passes in the `X-Alethe-Planner` position. If no such test exists, add one that calls `alethe_open_shell` through `handle_mcp_body` with a planner header and asserts the two lines above.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
Expected: `test result: ok`.

- [ ] **Step 8: Update the TypeScript type**

In `src/lib/tauri/orchestrator.ts`, above `OrchestratorShell`:

```ts
/** Who opened a shell. Only planners do today; a worker-owned shell needs no type change. */
export type OrchestratorShellOwner = { kind: 'planner' | 'worker'; id: string }
```

and inside `OrchestratorShell` replace `plannerId: string | null` with `owner: OrchestratorShellOwner | null`.

- [ ] **Step 9: Follow the compiler**

Run: `npm run build`
Fix every `plannerId` use it reports on shells (`src/lib/orchestratorShells.ts`, `src/components/OrchestratorPane/*`) by reading `shell.owner?.id ?? null` for now — Task 3 gives that logic its final shape. Do not touch `OrchestratorJob.plannerId`, which is a different field and stays.

Run: `npm test`
Expected: PASS (update the `plannerId: 'p1'` literal in `ShellCard.test.tsx` and any other shell fixture to `owner: { kind: 'planner', id: 'p1' }`).

- [ ] **Step 10: Stage**

```bash
git add src-tauri/src/orchestrator_shells.rs src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs src/lib/tauri/orchestrator.ts src/lib/orchestratorShells.ts src/components/OrchestratorPane
```

---

### Task 2: Cancel a worker from the app

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs` (the `"alethe_cancel"` arm in `dispatch_tool`)
- Modify: `src-tauri/src/orchestrator.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/orchestrator.rs`
- Modify: `src/lib/tauri/orchestrator.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Core::cancel_jobs(&self, job_ids: &[String]) -> Vec<String>` (returns the ids it acted on), Tauri command `orchestrator_cancel_job { jobId }`, and `orchestratorCancelJob(jobId: string): Promise<unknown>` in `src/lib/tauri/orchestrator.ts`.

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/tests/orchestrator.rs`:

```rust
#[test]
fn cancelling_through_the_core_settles_the_worker() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("cancel-method");
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["hold"], "timeoutSeconds": 120 }),
    );
    let job_id = core.snapshot()["jobs"][0]["id"].as_str().expect("a job").to_string();

    let cancelled = core.cancel_jobs(&[job_id.clone()]);

    assert_eq!(cancelled, vec![job_id.clone()]);
    let status = core.snapshot()["jobs"][0]["status"].clone();
    assert_eq!(status, json!("cancelled"), "{status}");

    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator cancelling_through_the_core`
Expected: FAIL — `no method named cancel_jobs found for struct Core`.

- [ ] **Step 3: Extract the method**

In `src-tauri/src/orchestrator_core.rs`, add to `impl Core` (near the other public methods):

```rust
    /// Interrupts running workers and settles them as cancelled. Returns the ids it acted on.
    /// Both `alethe_cancel` and the app's cancel command go through here.
    pub fn cancel_jobs(&self, job_ids: &[String]) -> Vec<String> {
        // body moved verbatim from the "alethe_cancel" arm, with `ids` renamed to `job_ids`
    }
```

Move the whole body of the `"alethe_cancel"` arm into it, unchanged, ending with `cancelled`. The arm becomes:

```rust
        "alethe_cancel" => {
            let cancelled = core.cancel_jobs(&string_list(arguments, "jobIds"));
            Ok(json!({ "cancelled": cancelled }))
        }
```

**Keep the arm's existing response payload exactly as it was** — read it before you replace it and reproduce the same JSON shape.

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
Expected: `test result: ok` — the new test and the pre-existing `alethe_cancel` test both pass.

- [ ] **Step 5: Add the Tauri command**

In `src-tauri/src/orchestrator.rs`, mirroring the shape of `orchestrator_job_diff` right above it:

```rust
#[tauri::command]
pub fn orchestrator_cancel_job(state: tauri::State<'_, OrchestratorState>, job_id: String) -> Value {
    json!({ "cancelled": state.core().cancel_jobs(&[job_id]) })
}
```

(Use whatever accessor the neighbouring commands use to reach the core; do not invent a new one.)

Register `orchestrator::orchestrator_cancel_job` in the `invoke_handler![...]` list in `src-tauri/src/lib.rs`, beside `orchestrator_job_diff`.

- [ ] **Step 6: Add the frontend wrapper**

In `src/lib/tauri/orchestrator.ts`, beside `orchestratorMessage`:

```ts
/** Interrupts a running worker and settles it as cancelled — the same path `alethe_cancel` takes. */
export async function orchestratorCancelJob(jobId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_cancel_job', { jobId })
}
```

Nothing else to do for the re-export: `src/lib/tauri/index.ts` already has `export * from './orchestrator'`.

- [ ] **Step 7: Verify**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → `test result: ok`
Run: `npm run build` → exit 0

- [ ] **Step 8: Stage**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/src/orchestrator.rs src-tauri/src/lib.rs src-tauri/tests/orchestrator.rs src/lib/tauri
```

---

### Task 3: Which shells the board shows, and how they attach

**Files:**
- Modify: `src/lib/orchestratorShells.ts`
- Modify: `src/lib/orchestratorShells.test.ts`

**Interfaces:**
- Consumes: `OrchestratorShell.owner` (Task 1).
- Produces: `export type ShellAttachment = 'attached' | 'detached'`; `export type BoardShell = OrchestratorShell & { attachment: ShellAttachment }`; `shellsForBoard(shells, { activePlannerId, livePlannerIds, projectCwd }): BoardShell[]`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/orchestratorShells.test.ts` (keep the existing tests; adapt their fixtures to `owner`):

```ts
describe('shellsForBoard attachment', () => {
  const base = {
    name: 'npm',
    command: 'npm run dev',
    status: 'running' as const,
    exitCode: null,
    startedAtMs: 0,
  }
  const shell = (id: string, ownerId: string | null, cwd: string) => ({
    ...base,
    id,
    cwd,
    owner: ownerId ? ({ kind: 'planner' as const, id: ownerId }) : null,
    ptyId: `orchestrator-${id}`,
  })

  it('marks the active planner\'s own shells attached', () => {
    const shells = shellsForBoard([shell('shell-01', 'p1', 'C:\\app')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\app',
    })
    expect(shells.map((s) => s.attachment)).toEqual(['attached'])
  })

  it('marks a shell whose planner is gone detached, when its cwd is under the project', () => {
    const shells = shellsForBoard([shell('shell-02', 'p9', 'C:\\app\\api')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\app',
    })
    expect(shells.map((s) => [s.id, s.attachment])).toEqual([['shell-02', 'detached']])
  })

  it('marks an ownerless shell detached', () => {
    const shells = shellsForBoard([shell('shell-03', null, 'C:\\app')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\app',
    })
    expect(shells.map((s) => s.attachment)).toEqual(['detached'])
  })

  it('leaves another live planner\'s shell to that planner\'s tab', () => {
    const shells = shellsForBoard([shell('shell-04', 'p2', 'C:\\app')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1', 'p2']),
      projectCwd: 'C:\\app',
    })
    expect(shells).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/orchestratorShells.test.ts`
Expected: FAIL — `attachment` is undefined.

- [ ] **Step 3: Implement**

Replace `shellsForBoard` in `src/lib/orchestratorShells.ts` with:

```ts
export type ShellAttachment = 'attached' | 'detached'

/** A shell as the board sees it: `attached` hangs off the planner node, `detached` stands alone. */
export type BoardShell = OrchestratorShell & { attachment: ShellAttachment }

/**
 * Which shells the board shows: the active planner's own, plus any shell whose owner is gone (or
 * never recorded) and whose cwd falls under this project — the same fallback the jobs filter uses,
 * so a `docker compose up` is never dropped just because the planner that started it closed.
 */
export function shellsForBoard(
  shells: readonly OrchestratorShell[],
  { activePlannerId, livePlannerIds, projectCwd }: ShellsForBoardParams,
): BoardShell[] {
  const board: BoardShell[] = []
  for (const shell of shells) {
    const ownerId = shell.owner?.id ?? null
    if (activePlannerId !== null && ownerId === activePlannerId) {
      board.push({ ...shell, attachment: 'attached' })
      continue
    }
    if (ownerId !== null && livePlannerIds.has(ownerId)) continue
    if (projectCwd === null || shell.cwd.startsWith(projectCwd)) {
      board.push({ ...shell, attachment: 'detached' })
    }
  }
  return board
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/orchestratorShells.test.ts`
Expected: PASS (all tests in the file, old and new).

- [ ] **Step 5: Stage**

```bash
git add src/lib/orchestratorShells.ts src/lib/orchestratorShells.test.ts
```

---

### Task 4: Shell nodes in the board layout

**Files:**
- Modify: `src/lib/orchestratorGraph.ts`
- Modify: `src/lib/orchestratorGraph.test.ts` (it already exists — append the new `describe` block, keep every existing test)

**Interfaces:**
- Consumes: `BoardShell` / `ShellAttachment` from Task 3.
- Produces: `GraphNodeKind` gains `'shellGroup' | 'shell'`; `shellGroupNodeId(attachment: ShellAttachment): string`; `BoardGraph` gains `shellGroups: GraphNode[]` and `shells: GraphNode[]`; `layoutPlannerBoard(runs, heights?, plannerId?, mediaByJobId?, shells?: readonly LayoutShell[])` where `export type LayoutShell = { id: string; attachment: ShellAttachment; status: OrchestratorShellStatus }`. A shell node's `id` is the shell id (`shell-01`); a group node's id is `shells:attached` / `shells:detached`.

- [ ] **Step 1: Write the failing tests**

Append to the existing `src/lib/orchestratorGraph.test.ts` (add `shellGroupNodeId` and `plannerNodeId` to its import from `./orchestratorGraph` if they are not imported yet, and reuse its own `run(...)` fixture if it has one instead of redefining it):

```ts
import { describe, expect, it } from 'vitest'

import { layoutPlannerBoard, plannerNodeId, shellGroupNodeId } from './orchestratorGraph'
import type { OrchestratorRun } from './orchestratorRuns'

const run = (id: string): OrchestratorRun => ({
  id,
  label: id,
  jobs: [],
  counts: { blocked: 0, running: 0, queued: 0, interrupted: 0, failed: 0, finished: 0 },
  state: 'finished',
})

const shell = (id: string, attachment: 'attached' | 'detached') => ({
  id,
  attachment,
  status: 'running' as const,
})

describe('layoutPlannerBoard with shells', () => {
  it('hangs the attached group off the planner, right of the runs', () => {
    const graph = layoutPlannerBoard([run('run-1')], undefined, 'p1', undefined, [
      shell('shell-01', 'attached'),
    ])
    const group = graph.shellGroups.find((node) => node.id === shellGroupNodeId('attached'))
    expect(group).toBeTruthy()
    expect(group!.x).toBeGreaterThan(graph.roots[0].x)
    expect(group!.y).toBe(graph.roots[0].y)
    expect(graph.shells.map((node) => node.id)).toEqual(['shell-01'])
    expect(graph.shells[0].y).toBe(graph.workers[0]?.y ?? graph.shells[0].y)
    expect(
      graph.edges.some(
        (edge) => edge.from === plannerNodeId('p1') && edge.to === shellGroupNodeId('attached'),
      ),
    ).toBe(true)
    expect(
      graph.edges.some(
        (edge) => edge.from === shellGroupNodeId('attached') && edge.to === 'shell-01',
      ),
    ).toBe(true)
  })

  it('gives a detached group no incoming edge', () => {
    const graph = layoutPlannerBoard([run('run-1')], undefined, 'p1', undefined, [
      shell('shell-09', 'detached'),
    ])
    expect(graph.edges.some((edge) => edge.to === shellGroupNodeId('detached'))).toBe(false)
    expect(graph.shells.map((node) => node.id)).toEqual(['shell-09'])
  })

  it('lays out shells with no runs at all', () => {
    const graph = layoutPlannerBoard([], undefined, null, undefined, [
      shell('shell-01', 'detached'),
    ])
    expect(graph.width).toBeGreaterThan(0)
    expect(graph.height).toBeGreaterThan(0)
    expect(graph.shells).toHaveLength(1)
  })

  it('adds no group when there are no shells', () => {
    const graph = layoutPlannerBoard([run('run-1')], undefined, 'p1', undefined, [])
    expect(graph.shellGroups).toEqual([])
    expect(graph.shells).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/orchestratorGraph.test.ts`
Expected: FAIL — `shellGroupNodeId is not a function`.

- [ ] **Step 3: Extend the types**

In `src/lib/orchestratorGraph.ts`:

```ts
const SHELL_GROUP_PREFIX = 'shells:'

export type GraphNodeKind = 'planner' | 'run' | 'worker' | 'media' | 'shellGroup' | 'shell'

/** What the layout needs of a shell: identity, where it hangs, and whether it is running. */
export type LayoutShell = {
  id: string
  attachment: ShellAttachment
  status: OrchestratorShellStatus
}

export function shellGroupNodeId(attachment: ShellAttachment): string {
  return `${SHELL_GROUP_PREFIX}${attachment}`
}
```

with `import type { ShellAttachment } from './orchestratorShells'` and
`import type { OrchestratorShellStatus } from './tauri/orchestrator'` at the top.

Add to `BoardGraph` and to `EMPTY_BOARD`:

```ts
  shellGroups: GraphNode[]
  shells: GraphNode[]
```

(`EMPTY_BOARD` gets `shellGroups: [], shells: [],`.)

- [ ] **Step 4: Lay the shells out**

In `layoutPlannerBoard`, change the signature and the early return:

```ts
export function layoutPlannerBoard(
  runs: OrchestratorRun[],
  heights?: NodeHeights,
  plannerId?: string | null,
  mediaByJobId?: ReadonlyMap<string, MediaItem>,
  shells: readonly LayoutShell[] = [],
): BoardGraph {
  if (runs.length === 0 && shells.length === 0) return EMPTY_BOARD

  const groupsByAttachment: ShellAttachment[] = (['attached', 'detached'] as const).filter(
    (attachment) => shells.some((shell) => shell.attachment === attachment),
  )
```

Extend the span/left computation so each shell group is a tree of its own, sitting after the runs:

```ts
  const shellSpan = (attachment: ShellAttachment): number => {
    const count = shells.filter((shell) => shell.attachment === attachment).length
    return count * NODE_WIDTH + (count - 1) * SIBLING_GAP
  }

  const spans = [
    ...runs.map((run) =>
      run.jobs.length > 0
        ? run.jobs.length * NODE_WIDTH + (run.jobs.length - 1) * SIBLING_GAP
        : NODE_WIDTH,
    ),
    ...groupsByAttachment.map(shellSpan),
  ]
```

`lefts` stays as it is (it already walks `spans`). Guard the two places that assume at least one run:

```ts
  const runHeights = runs.map((run) => heightOf(heights, rootNodeId(run.id)))
  const groupHeights = groupsByAttachment.map((attachment) =>
    heightOf(heights, shellGroupNodeId(attachment)),
  )
  const rowHeights = [...runHeights, ...groupHeights]
  // Every worker and shell in the forest shares one baseline, so the levels read as levels.
  const workerTop = runTop + Math.max(...rowHeights) + LEVEL_GAP
```

After the existing `runs.forEach(...)` block, lay out the groups (their index into `lefts`/`spans` is `runs.length + groupIndex`):

```ts
  const shellGroups: GraphNode[] = []
  const shellNodes: GraphNode[] = []

  groupsByAttachment.forEach((attachment, groupIndex) => {
    const index = runs.length + groupIndex
    const groupId = shellGroupNodeId(attachment)
    const members = shells.filter((shell) => shell.attachment === attachment)
    const group: GraphNode = {
      id: groupId,
      kind: 'shellGroup',
      depth: plannerId ? 1 : 0,
      index,
      x: Math.round(lefts[index] + (spans[index] - NODE_WIDTH) / 2),
      y: runTop,
      width: NODE_WIDTH,
      height: groupHeights[groupIndex],
    }
    shellGroups.push(group)
    let bottom = group.y + group.height

    members.forEach((shell, column) => {
      const node: GraphNode = {
        id: shell.id,
        kind: 'shell',
        depth: group.depth + 1,
        index: column,
        x: lefts[index] + column * (NODE_WIDTH + SIBLING_GAP),
        y: workerTop,
        width: NODE_WIDTH,
        height: heightOf(heights, shell.id),
      }
      shellNodes.push(node)
      bottom = Math.max(bottom, node.y + node.height)
      runEdges.push({
        id: `${groupId}->${node.id}`,
        from: groupId,
        to: node.id,
        lane: shell.status === 'running' ? 'running' : 'finished',
        d: connectorPath(centerX(group), group.y + group.height, centerX(node), node.y),
        note: null,
      })
    })

    trees.push({
      id: groupId,
      label: attachment,
      lane: members.some((shell) => shell.status === 'running') ? 'running' : 'finished',
      x: lefts[index],
      y: group.y,
      width: spans[index],
      height: bottom - group.y,
    })
  })
```

In the planner block, centre the planner over every root **and** the attached group, and give the attached group its edge — a detached group never gets one:

```ts
  if (plannerId) {
    const attached = shellGroups.find((group) => group.id === shellGroupNodeId('attached')) ?? null
    const heads = [...roots, ...(attached ? [attached] : [])]
    const first = centerX(heads[0])
    const last = centerX(heads[heads.length - 1])
    planner = { /* unchanged, using first/last */ }
    roots.forEach((root, index) => { /* unchanged */ })
    if (attached) {
      plannerEdges.push({
        id: `${planner.id}->${attached.id}`,
        from: planner.id,
        to: attached.id,
        lane: 'running',
        d: connectorPath(centerX(planner), planner.y + planner.height, centerX(attached), attached.y),
        note: null,
      })
    }
  }
```

Return `shellGroups` and `shells: shellNodes` in the result object. The `height` line already derives from `trees`, which now includes the shell groups.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/orchestratorGraph.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS — if another test calls `layoutPlannerBoard`, the new parameter defaults to `[]` and nothing changes for it.

- [ ] **Step 6: Stage**

```bash
git add src/lib/orchestratorGraph.ts src/lib/orchestratorGraph.test.ts
```

---

### Task 5: Message shortcuts — types, built-ins and rendering

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/orchestratorShortcuts.ts`
- Create: `src/lib/orchestratorShortcuts.test.ts`
- Modify: `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`

**Interfaces:**
- Consumes: `OrchestratorJob` from `src/lib/tauri/orchestrator.ts`.
- Produces, in `src/lib/types.ts`: `export type ShortcutRule = 'any' | 'finished' | 'finishedIsolated'` and `export type OrchestratorShortcut = { id: string; name: string; text: string; rule: ShortcutRule }`. In `src/lib/orchestratorShortcuts.ts`: `builtinShortcuts(t: TFunction): OrchestratorShortcut[]`, `resolveShortcuts(stored: OrchestratorShortcut[] | undefined, t: TFunction): OrchestratorShortcut[]`, `shortcutsForJob(shortcuts: readonly OrchestratorShortcut[], job: OrchestratorJob): OrchestratorShortcut[]`, `renderShortcut(shortcut: OrchestratorShortcut, job: OrchestratorJob, projectCwd: string | null): string`, `workerBranch(jobId: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/orchestratorShortcuts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { TFunction } from './i18n'
import {
  builtinShortcuts,
  renderShortcut,
  resolveShortcuts,
  shortcutsForJob,
  workerBranch,
} from './orchestratorShortcuts'
import type { OrchestratorJob } from './tauri/orchestrator'

const t = ((key: string) => key) as unknown as TFunction

const job = (patch: Partial<OrchestratorJob> = {}): OrchestratorJob =>
  ({
    id: 'job-03',
    plannerId: 'p1',
    agent: 'codex',
    runId: 'run-1',
    runLabel: null,
    spec: 'do the thing',
    cwd: 'C:\\app',
    status: 'done',
    threadId: null,
    outcome: null,
    seconds: 12,
    plan: [],
    tokens: null,
    quota: null,
    routing: null,
    worktree: 'C:\\app',
    pendingApproval: null,
    hasDiff: true,
    summary: 'done',
    ...patch,
  }) as OrchestratorJob

describe('shortcutsForJob', () => {
  const shortcuts = builtinShortcuts(t)

  it('offers apply only to an isolated worker that finished', () => {
    const ids = shortcutsForJob(shortcuts, job()).map((s) => s.id)
    expect(ids).toContain('apply')

    const noWorktree = shortcutsForJob(shortcuts, job({ worktree: null })).map((s) => s.id)
    expect(noWorktree).not.toContain('apply')

    const running = shortcutsForJob(shortcuts, job({ status: 'running' })).map((s) => s.id)
    expect(running).not.toContain('apply')
    expect(running).not.toContain('review')
    expect(running).toContain('continue')
  })

  it('offers nothing for a native subagent', () => {
    expect(shortcutsForJob(shortcuts, job({ native: true }))).toEqual([])
  })
})

describe('renderShortcut', () => {
  it('substitutes every placeholder', () => {
    const text = renderShortcut(
      { id: 'x', name: 'x', rule: 'any', text: '{jobId} {agent} {branch} {worktree} {project}' },
      job(),
      'C:\\project',
    )
    expect(text).toBe(`job-03 codex ${workerBranch('job-03')} C:\\app C:\\project`)
  })

  it('leaves no braces behind when a job has no worktree and no project', () => {
    const text = renderShortcut(
      { id: 'x', name: 'x', rule: 'any', text: '[{worktree}] [{project}]' },
      job({ worktree: null }),
      null,
    )
    expect(text).toBe('[] []')
  })
})

describe('resolveShortcuts', () => {
  it('falls back to the built-ins when nothing is stored', () => {
    expect(resolveShortcuts(undefined, t).map((s) => s.id)).toEqual(['apply', 'review', 'continue'])
    expect(resolveShortcuts([], t).map((s) => s.id)).toEqual(['apply', 'review', 'continue'])
  })

  it('keeps what the person stored', () => {
    const stored = [{ id: 'mine', name: 'Mine', text: 'go', rule: 'any' as const }]
    expect(resolveShortcuts(stored, t)).toEqual(stored)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/orchestratorShortcuts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the domain types**

In `src/lib/types.ts`, beside the other orchestrator-facing types:

```ts
/** When a message shortcut shows on a worker. */
export type ShortcutRule = 'any' | 'finished' | 'finishedIsolated'

/** A one-click instruction for the planner, written into its terminal for the person to edit. */
export type OrchestratorShortcut = {
  id: string
  name: string
  text: string
  rule: ShortcutRule
}
```

In `Preferences`, add:

```ts
  /** Empty means "use Alethe's built-ins"; editing one stores the whole list. */
  orchestratorShortcuts: OrchestratorShortcut[]
```

and in `DEFAULT_PREFERENCES`: `orchestratorShortcuts: [],`.
No migration is needed: `normalizePreferences` in `src/stores/projectsStore.migrations.ts` already spreads `DEFAULT_PREFERENCES` under the stored object.

- [ ] **Step 4: Write the module**

Create `src/lib/orchestratorShortcuts.ts`:

```ts
import type { TFunction } from './i18n'
import type { OrchestratorJob } from './tauri/orchestrator'
import type { OrchestratorShortcut } from './types'

/** The branch `alethe_delegate` gives an isolated worker, which the planner merges to apply it. */
export function workerBranch(jobId: string): string {
  return `alethe/agent-${jobId}`
}

/** Alethe's own shortcuts. Their text lives in the locale files, so they arrive translated. */
export function builtinShortcuts(t: TFunction): OrchestratorShortcut[] {
  return [
    {
      id: 'apply',
      name: t('orchestrator.shortcut.applyName'),
      text: t('orchestrator.shortcut.applyText'),
      rule: 'finishedIsolated',
    },
    {
      id: 'review',
      name: t('orchestrator.shortcut.reviewName'),
      text: t('orchestrator.shortcut.reviewText'),
      rule: 'finished',
    },
    {
      id: 'continue',
      name: t('orchestrator.shortcut.continueName'),
      text: t('orchestrator.shortcut.continueText'),
      rule: 'any',
    },
  ]
}

export function resolveShortcuts(
  stored: OrchestratorShortcut[] | undefined,
  t: TFunction,
): OrchestratorShortcut[] {
  return stored && stored.length > 0 ? stored : builtinShortcuts(t)
}

function matches(rule: OrchestratorShortcut['rule'], job: OrchestratorJob): boolean {
  if (rule === 'any') return true
  if (job.status !== 'done') return false
  return rule === 'finished' || job.worktree !== null
}

/**
 * A native subagent gets none: it has no backend job, so there is nothing for the planner to act on.
 */
export function shortcutsForJob(
  shortcuts: readonly OrchestratorShortcut[],
  job: OrchestratorJob,
): OrchestratorShortcut[] {
  if (job.native) return []
  return shortcuts.filter((shortcut) => matches(shortcut.rule, job))
}

export function renderShortcut(
  shortcut: OrchestratorShortcut,
  job: OrchestratorJob,
  projectCwd: string | null,
): string {
  const values: Record<string, string> = {
    jobId: job.id,
    agent: job.agent,
    branch: workerBranch(job.id),
    worktree: job.worktree ?? '',
    project: projectCwd ?? '',
  }
  return shortcut.text.replace(/\{(jobId|agent|branch|worktree|project)\}/g, (_, key: string) =>
    values[key] ?? '',
  )
}
```

- [ ] **Step 5: Add the locale strings**

In `src/lib/i18n/messages/en.ts`, beside the other `orchestrator.*` keys:

```ts
  'orchestrator.shortcut.applyName': 'Apply',
  'orchestrator.shortcut.applyText':
    'Bring worker {jobId} into the project: commit what it left in {worktree}, merge {branch} into the current branch, and tell me if anything conflicts.',
  'orchestrator.shortcut.reviewName': 'Review',
  'orchestrator.shortcut.reviewText':
    'Read worker {jobId}\u2019s report and its diff, then tell me whether it did what it was asked and what you would change.',
  'orchestrator.shortcut.continueName': 'Continue',
  'orchestrator.shortcut.continueText':
    'Send worker {jobId} more work on its existing thread, keeping everything it already learned.',
```

and the matching pt-BR translations in `src/lib/i18n/messages/pt-BR.ts`:

```ts
  'orchestrator.shortcut.applyName': 'Aplicar',
  'orchestrator.shortcut.applyText':
    'Traga o trabalho do worker {jobId} para o projeto: faça commit do que ele deixou em {worktree}, dê merge de {branch} na branch atual e me avise se houver conflito.',
  'orchestrator.shortcut.reviewName': 'Revisar',
  'orchestrator.shortcut.reviewText':
    'Leia o relatório e o diff do worker {jobId} e me diga se ele fez o que foi pedido e o que você mudaria.',
  'orchestrator.shortcut.continueName': 'Continuar',
  'orchestrator.shortcut.continueText':
    'Mande mais trabalho ao worker {jobId} no thread que ele já tem, aproveitando tudo o que ele aprendeu.',
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/orchestratorShortcuts.test.ts` → PASS
Run: `npm run build` → exit 0 (proves i18n parity)

- [ ] **Step 7: Stage**

```bash
git add src/lib/types.ts src/lib/orchestratorShortcuts.ts src/lib/orchestratorShortcuts.test.ts src/lib/i18n/messages
```

---

### Task 6: Editing the shortcuts in Preferences

**Files:**
- Modify: `src/components/modals/preferences/MultiagentPage.tsx`
- Modify: `src/components/modals/preferences/MultiagentPage.module.css`
- Modify: `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`

**Interfaces:**
- Consumes: `resolveShortcuts`, `builtinShortcuts` (Task 5), `Preferences.orchestratorShortcuts`.
- Produces: a `SettingsSection` with id `orchestrator-shortcuts` on the Multiagent page. No exported API.

- [ ] **Step 1: Render the list**

At the top of `MultiagentPage`, read and write the preference:

```tsx
  const shortcuts = useProjectsStore((state) => state.preferences.orchestratorShortcuts)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const rows = resolveShortcuts(shortcuts, t)
  const save = (next: OrchestratorShortcut[]) => setPreferences({ orchestratorShortcuts: next })
```

Add a section after the existing ones (follow the file's own `SettingsSection` usage):

```tsx
      <SettingsSection
        id="orchestrator-shortcuts"
        title={t('prefs.orchestratorShortcuts')}
        description={t('prefs.orchestratorShortcutsDesc')}
      >
        <div className={multiagentStyles.shortcutList}>
          {rows.map((shortcut, index) => (
            <div key={shortcut.id} className={multiagentStyles.shortcut}>
              <input
                className={multiagentStyles.shortcutName}
                value={shortcut.name}
                aria-label={t('prefs.shortcutName')}
                onChange={(event) =>
                  save(rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))
                }
              />
              <select
                className={multiagentStyles.shortcutRule}
                value={shortcut.rule}
                aria-label={t('prefs.shortcutRule')}
                onChange={(event) =>
                  save(
                    rows.map((row, i) =>
                      i === index ? { ...row, rule: event.target.value as ShortcutRule } : row,
                    ),
                  )
                }
              >
                <option value="any">{t('prefs.shortcutRuleAny')}</option>
                <option value="finished">{t('prefs.shortcutRuleFinished')}</option>
                <option value="finishedIsolated">{t('prefs.shortcutRuleIsolated')}</option>
              </select>
              <textarea
                className={multiagentStyles.shortcutText}
                value={shortcut.text}
                rows={3}
                aria-label={t('prefs.shortcutText')}
                onChange={(event) =>
                  save(rows.map((row, i) => (i === index ? { ...row, text: event.target.value } : row)))
                }
              />
              <div className={multiagentStyles.shortcutActions}>
                <button
                  type="button"
                  onClick={() => {
                    const original = builtinShortcuts(t).find((entry) => entry.id === shortcut.id)
                    if (original) save(rows.map((row, i) => (i === index ? original : row)))
                  }}
                  disabled={!builtinShortcuts(t).some((entry) => entry.id === shortcut.id)}
                >
                  {t('prefs.shortcutRestore')}
                </button>
                <button type="button" onClick={() => save(rows.filter((_, i) => i !== index))}>
                  {t('prefs.shortcutDelete')}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className={multiagentStyles.shortcutHint}>{t('prefs.shortcutPlaceholders')}</p>
        <button
          type="button"
          onClick={() =>
            save([
              ...rows,
              {
                id: `custom-${Date.now()}`,
                name: t('prefs.shortcutNewName'),
                text: '',
                rule: 'any',
              },
            ])
          }
        >
          {t('prefs.shortcutAdd')}
        </button>
      </SettingsSection>
```

- [ ] **Step 2: Add the locale strings**

`en.ts`:

```ts
  'prefs.orchestratorShortcuts': 'Orchestration shortcuts',
  'prefs.orchestratorShortcutsDesc':
    'One-click instructions for the lead agent. Clicking one on the board writes it into the lead\u2019s terminal, where you edit it before sending.',
  'prefs.shortcutName': 'Name',
  'prefs.shortcutText': 'Message',
  'prefs.shortcutRule': 'Shows on',
  'prefs.shortcutRuleAny': 'Any worker',
  'prefs.shortcutRuleFinished': 'A worker that finished',
  'prefs.shortcutRuleIsolated': 'An isolated worker that finished',
  'prefs.shortcutRestore': 'Restore default',
  'prefs.shortcutDelete': 'Delete',
  'prefs.shortcutAdd': 'Add shortcut',
  'prefs.shortcutNewName': 'New shortcut',
  'prefs.shortcutPlaceholders':
    'Available: {jobId}, {agent}, {branch}, {worktree}, {project}.',
```

pt-BR translations of the same keys.

The braces in `prefs.shortcutPlaceholders` are safe: `interpolate` in `src/lib/i18n/index.ts:98-103` returns the message untouched when `t()` is called with no params, and leaves an unknown `{key}` in place even when it is. Call it as `t('prefs.shortcutPlaceholders')`, with no second argument.

- [ ] **Step 3: Style it**

Add to `MultiagentPage.module.css`, tokens only:

```css
.shortcutList {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.shortcut {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
}

.shortcutText {
  grid-column: 1 / -1;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 12px;
}

.shortcutActions {
  grid-column: 1 / -1;
  display: flex;
  gap: 6px;
}

.shortcutHint {
  margin: 8px 0 0;
  color: var(--fg-muted);
  font-size: 11px;
}
```

Reuse the page's existing input/select/button styling if it has any; do not introduce a second look.

- [ ] **Step 4: Verify**

Run: `npm run build` → exit 0
Run: `npm test` → PASS

- [ ] **Step 5: Stage**

```bash
git add src/components/modals/preferences src/lib/i18n/messages
```

---

### Task 7: The inspector overlay

**Files:**
- Create: `src/components/OrchestratorPane/OrchestratorInspector.tsx`
- Create: `src/components/OrchestratorPane/OrchestratorInspector.module.css`
- Create: `src/components/OrchestratorPane/OrchestratorInspector.test.tsx`
- Modify: `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`

**Interfaces:**
- Consumes: `shortcutsForJob` (Task 5), `shellControls` + `BoardShell` (Task 3), `OrchestratorJob`, `OrchestratorShell`.
- Produces:

```ts
export type InspectorTarget =
  | { kind: 'worker'; job: OrchestratorJob }
  | { kind: 'shell'; shell: OrchestratorShell }

export type OrchestratorInspectorProps = {
  target: InspectorTarget
  projectId: string
  theme: Theme
  terminalTheme: Theme
  diffText: string | undefined
  diffLoading: boolean
  shortcuts: readonly OrchestratorShortcut[]
  shellBusy: boolean
  canStopJob: boolean
  onClose: () => void
  onLoadDiff: (jobId: string) => void
  onStopJob: (jobId: string) => void
  onShortcut: (job: OrchestratorJob, shortcut: OrchestratorShortcut) => void
  onShellControl: (shell: OrchestratorShell, control: ShellControl) => void
  t: TFunction
}
```

- [ ] **Step 1: Write the failing test**

Create `src/components/OrchestratorPane/OrchestratorInspector.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../XTermView', () => ({ XTermView: () => <div data-testid="xterm" /> }))
vi.mock('../MarkdownPane/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

import type { TFunction } from '../../lib/i18n'
import type { OrchestratorJob, OrchestratorShell } from '../../lib/tauri/orchestrator'
import { OrchestratorInspector } from './OrchestratorInspector'

afterEach(cleanup)

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${Object.values(vars).join(' ')}` : key) as unknown as TFunction

const job = (patch: Partial<OrchestratorJob> = {}): OrchestratorJob =>
  ({
    id: 'job-01',
    plannerId: 'p1',
    agent: 'codex',
    runId: 'run-1',
    runLabel: null,
    spec: 'spec',
    cwd: 'C:\\app',
    status: 'done',
    threadId: null,
    outcome: null,
    seconds: 4,
    plan: ['step one'],
    tokens: null,
    quota: null,
    routing: null,
    worktree: null,
    pendingApproval: null,
    hasDiff: true,
    summary: 'the report body',
    ...patch,
  }) as OrchestratorJob

const shell: OrchestratorShell = {
  id: 'shell-01',
  name: 'npm',
  command: 'npm run dev',
  cwd: 'C:\\app',
  owner: { kind: 'planner', id: 'p1' },
  status: 'running',
  exitCode: null,
  startedAtMs: 0,
  ptyId: 'orchestrator-shell-01',
}

const base = {
  projectId: 'proj',
  theme: 'dark' as const,
  terminalTheme: 'dark' as const,
  diffText: undefined,
  diffLoading: false,
  shortcuts: [{ id: 'review', name: 'Review', text: 'review {jobId}', rule: 'finished' as const }],
  shellBusy: false,
  canStopJob: false,
  onClose: vi.fn(),
  onLoadDiff: vi.fn(),
  onStopJob: vi.fn(),
  onShortcut: vi.fn(),
  onShellControl: vi.fn(),
  t,
}

describe('OrchestratorInspector', () => {
  it('shows a worker\u2019s plan and report, and its diff tab on demand', () => {
    const onLoadDiff = vi.fn()
    render(
      <OrchestratorInspector
        {...base}
        onLoadDiff={onLoadDiff}
        target={{ kind: 'worker', job: job() }}
      />,
    )
    expect(screen.getByText('step one')).toBeTruthy()
    expect(screen.getByText('the report body')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'orchestrator.diffTab' }))
    expect(onLoadDiff).toHaveBeenCalledWith('job-01')
  })

  it('hides the diff tab when the worker changed nothing', () => {
    render(
      <OrchestratorInspector {...base} target={{ kind: 'worker', job: job({ hasDiff: false }) }} />,
    )
    expect(screen.queryByRole('tab', { name: 'orchestrator.diffTab' })).toBeNull()
  })

  it('offers no stop and no diff for a native subagent', () => {
    render(
      <OrchestratorInspector
        {...base}
        canStopJob={false}
        target={{ kind: 'worker', job: job({ native: true, hasDiff: false }) }}
      />,
    )
    expect(screen.queryByRole('button', { name: 'orchestrator.stopWorker' })).toBeNull()
  })

  it('sends the shortcut that was clicked', () => {
    const onShortcut = vi.fn()
    render(
      <OrchestratorInspector
        {...base}
        onShortcut={onShortcut}
        target={{ kind: 'worker', job: job() }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-01' }),
      expect.objectContaining({ id: 'review' }),
    )
  })

  it('renders a shell as a live terminal with its controls', () => {
    const onShellControl = vi.fn()
    render(
      <OrchestratorInspector
        {...base}
        onShellControl={onShellControl}
        target={{ kind: 'shell', shell }}
      />,
    )
    expect(screen.getByTestId('xterm')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'orchestrator.shell.stop' }))
    expect(onShellControl).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shell-01' }),
      'stop',
    )
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <OrchestratorInspector {...base} onClose={onClose} target={{ kind: 'worker', job: job() }} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/OrchestratorPane/OrchestratorInspector.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Create `src/components/OrchestratorPane/OrchestratorInspector.tsx`. Structure (fill in the head metadata from the job the way `WorkerNode` does today — elapsed, tokens, context share, branch):

```tsx
import { Play, RotateCcw, Square, Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useOnEscape } from '../../hooks/useOnEscape'
import type { MessageKey, TFunction } from '../../lib/i18n'
import { type ShellControl, shellControls } from '../../lib/orchestratorShells'
import type { OrchestratorJob, OrchestratorShell } from '../../lib/tauri/orchestrator'
import type { OrchestratorShortcut, Theme } from '../../lib/types'
import { MarkdownRenderer } from '../MarkdownPane/MarkdownRenderer'
import { XTermView } from '../XTermView'
import styles from './OrchestratorInspector.module.css'

type Tab = 'report' | 'diff'

export function OrchestratorInspector(props: OrchestratorInspectorProps) {
  const { target, onClose, t } = props
  const [tab, setTab] = useState<Tab>('report')

  useOnEscape((event) => {
    event.preventDefault()
    onClose()
  }, true, { capture: true })

  useEffect(() => {
    setTab('report')
  }, [target.kind === 'worker' ? target.job.id : target.shell.id])

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {target.kind === 'worker'
          ? renderWorker(props, tab, setTab)
          : renderShell(props, target.shell)}
      </div>
    </div>
  )
}
```

Worker body:

- Head: agent glyph (import `AgentIcon` the way `index.tsx` does, or accept a rendered glyph via props — pick one and keep it consistent), `job.id`, the status label `t(`orchestrator.status.${job.status}`)`, elapsed, tokens, context share, and the branch when `job.worktree` is set.
- Head right: a stop button (`aria-label={t('orchestrator.stopWorker')}`) rendered only when `props.canStopJob`; one button per `shortcutsForJob(props.shortcuts, job)` labelled with `shortcut.name`, calling `props.onShortcut(job, shortcut)`; the close button.
- Tabs: a `role="tablist"` with `report` always, and `diff` only when `job.hasDiff`. Selecting `diff` calls `props.onLoadDiff(job.id)` once.
- Report tab: the plan as a `<ul>` when `job.plan` has non-empty entries, the report through `MarkdownRenderer` (`dark={props.theme === 'dark'}`), and the media strip — move `extractMediaItems`, the link buttons and the image preview `Modal` over from `WorkerNode` unchanged, including the "first image is promoted to its own node" filtering.
- Diff tab: `props.diffLoading ? <p>{t('orchestrator.diffLoading')}</p> :` the same coloured `<pre>` rendering `WorkerNode` used (`diffLineClass`) — move that helper into this file or a shared one; do not duplicate it in both.

Shell body:

- Head: name, command in `--font-mono`, cwd, status label (running / stopped / `orchestrator.shell.exited` with the code), then one button per `shellControls(shell.status)` (icons `Square`, `RotateCcw`, `Play`, `TerminalIcon`, `Trash2`, labels `orchestrator.shell.*` as `ShellCard` had them), disabled while `props.shellBusy` except `openTerminal`, and the close button.
- Body: `<XTermView ptyId={shell.ptyId} projectId={props.projectId} command={null} cwd={shell.cwd} terminalTheme={props.terminalTheme} />`.

- [ ] **Step 4: Style it**

Create `OrchestratorInspector.module.css` modelled on `src/components/LinkViewerOverlay/LinkViewerOverlay.module.css`:

```css
.backdrop {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--overlay-scrim, rgba(10, 12, 16, 0.55));
  backdrop-filter: blur(10px);
}

.panel {
  display: flex;
  flex-direction: column;
  width: min(1100px, 92%);
  height: min(780px, 88%);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg);
  box-shadow: var(--shadow-modal, 0 24px 64px rgba(0, 0, 0, 0.45));
}
```

plus `.head`, `.headMeta`, `.headActions`, `.tabs`, `.tab`, `.body`, `.report`, `.plan`, `.diff`, `.terminal` (flex: 1; min-height: 0). Use only tokens; check `src/styles/theme.css` for `--overlay-scrim` / `--shadow-modal` and, if they do not exist, use the tokens that do (e.g. `--bg-sunken`, `--border`) rather than inventing values.

- [ ] **Step 5: Add the locale strings**

`en.ts` (+ pt-BR): `'orchestrator.reportTab': 'Report'`, `'orchestrator.diffTab': 'Diff'`, `'orchestrator.stopWorker': 'Stop this worker'`, `'orchestrator.inspectorClose': 'Close'`, `'orchestrator.shellCwd': 'in {path}'`, `'orchestrator.noPlannerForShortcuts': 'The agent that started this worker is no longer open, so there is nobody to send an instruction to.'`

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/components/OrchestratorPane/OrchestratorInspector.test.tsx` → PASS
Run: `npm run build` → exit 0

- [ ] **Step 7: Stage**

```bash
git add src/components/OrchestratorPane src/lib/i18n/messages
```

---

### Task 8: Wire the board — nodes, hover, inspector; remove the rail section and the strip

**Files:**
- Create: `src/components/OrchestratorPane/ShellNode.tsx`, `ShellNode.module.css`, `ShellNode.test.tsx`
- Delete: `src/components/OrchestratorPane/ShellCard.tsx`, `ShellCard.module.css`, `ShellCard.test.tsx`
- Modify: `src/components/OrchestratorPane/index.tsx`, `OrchestratorPane.module.css`
- Modify: `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`

**Interfaces:**
- Consumes: everything from Tasks 3, 4, 5, 7, plus `orchestratorCancelJob` (Task 2).
- Produces: no new exported API beyond `ShellNode`.

- [ ] **Step 1: Write the failing ShellNode test**

Create `src/components/OrchestratorPane/ShellNode.test.tsx`, adapted from the deleted `ShellCard.test.tsx`: it renders the compact card, asserts the command and the last output line are shown, asserts `shellControls` are present on the hover bar (render it always in the DOM; CSS hides it until hover, so the test can click it), and asserts a click on the card body calls `onOpen`.

```tsx
  it('opens the inspector when the card is clicked', () => {
    const onOpen = vi.fn()
    render(<ShellNode {...props} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /npm run dev/ }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'shell-01' }))
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/OrchestratorPane/ShellNode.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write ShellNode**

```tsx
type ShellNodeProps = {
  shell: BoardShell
  node: GraphNode
  selected: boolean
  busy: boolean
  onOpen: (shell: OrchestratorShell) => void
  onControl: (shell: OrchestratorShell, control: ShellControl) => void
  bind: BindNode
  t: TFunction
}
```

The article is positioned like `WorkerNode` (`style={{ left: node.x, top: node.y, width: node.width }}`, `ref={(element) => bind(shell.id, element)}`, `data-status={shell.status}`, `data-selected={selected ? 'true' : undefined}`). Inside: a hover action bar (`div.controls`) with one button per `shellControls(shell.status)`, and a `button.card` whose title is the command and whose click calls `onOpen(shell)`. The card shows the status dot, the name, the status label and the command; the last output line comes from the existing `orchestratorShellOutput(shell.id, 1)` poll (2 s while running, once otherwise) — carry that effect over from `ShellCard` unchanged, asking for **1** line instead of 12.

CSS: copy what `ShellCard.module.css` had for `.dot`, `.name`, `.status`, `.command`, `.control`; add

```css
.controls {
  position: absolute;
  top: -30px;
  right: 0;
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--anim-fast);
}

.node:hover .controls,
.node:focus-within .controls {
  opacity: 1;
  pointer-events: auto;
}
```

- [ ] **Step 4: Run the ShellNode test**

Run: `npx vitest run src/components/OrchestratorPane/ShellNode.test.tsx` → PASS

- [ ] **Step 5: Strip the worker node and add its hover bar**

In `src/components/OrchestratorPane/index.tsx`, inside `WorkerNode`:

- Delete the whole `{selected && (<div className={styles.detail}>…</div>)}` block, and with it the now-unused `previewMedia` state, `remainingMedia` memo, media strip, `Modal` usage, `detailActions` and diff block (they live in the inspector now).
- Keep the card button, the `ApprovalAsk` block, the failure `errBar` and the context track.
- Add a hover bar above the card, same shape as `ShellNode`'s: a stop button when `canStop(job)` (`job.status` is `queued`, `running` or `blocked`, and `!job.native`), then one button per `shortcutsForJob(shortcuts, job)`.
- `onSelect` keeps its name but now means "open the inspector".
- Drop the props that no longer apply (`diffOpen`, `diffText`, `diffLoading`, `onToggleDiff`, `onApply`, `onMessage`, `applying`, `applied`, `projectId`) and add `shortcuts`, `onStop`, `onShortcut`.

Delete `applyWorktree`, `focusComposer`, `canMessage`, `messageMode`, the composer `<form>` and its state, and the `mergeAnalyze` / `mergeFinalize` / `mergePrepare` / `worktree*` imports they were the only users of — **check with a search before deleting an import; some are used elsewhere in the file.**

- [ ] **Step 6: Render the new nodes and the inspector**

In the pane body:

```tsx
  const shortcuts = resolveShortcuts(
    useProjectsStore((state) => state.preferences.orchestratorShortcuts),
    t,
  )
  const [inspecting, setInspecting] = useState<{ kind: 'worker' | 'shell'; id: string } | null>(null)
  // The pane has no terminal theme of its own yet; every other host of XTermView derives it this way
  // (see TerminalPane/index.tsx:138-140).
  const terminalTheme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
```

Feed the layout:

```tsx
  const layoutShells = useMemo(
    () => shells.map((shell) => ({ id: shell.id, attachment: shell.attachment, status: shell.status })),
    [shells],
  )
  const graph = useMemo(
    () => layoutPlannerBoard(runs, heights, plannerId, promotedMediaByJobId, layoutShells),
    [runs, heights, plannerId, promotedMediaByJobId, layoutShells],
  )
```

Render, beside `graph.workers`:

```tsx
                    {graph.shellGroups.map((node) => (
                      <ShellGroupNode
                        key={node.id}
                        node={node}
                        attachment={node.id.endsWith('detached') ? 'detached' : 'attached'}
                        count={shells.filter((shell) =>
                          node.id.endsWith('detached')
                            ? shell.attachment === 'detached'
                            : shell.attachment === 'attached',
                        ).length}
                        bind={bind}
                        t={t}
                      />
                    ))}

                    {graph.shells.map((node) => {
                      const shell = shellById.get(node.id)
                      if (!shell) return null
                      return (
                        <ShellNode
                          key={node.id}
                          shell={shell}
                          node={node}
                          selected={inspecting?.kind === 'shell' && inspecting.id === shell.id}
                          busy={shellBusy.has(shell.id)}
                          onOpen={openShellInspector}
                          onControl={(target, control) => void controlShell(target, control)}
                          bind={bind}
                          t={t}
                        />
                      )
                    })}
```

`ShellGroupNode` is a small local component in this file, shaped like `RunNode`: an `article` positioned from the node, with an eyebrow `t('orchestrator.shellsEyebrow')`, a label `t(attachment === 'attached' ? 'orchestrator.shellsLabel' : 'orchestrator.shellsOrphanLabel')` and a count `t('orchestrator.shellCount', { count })`.

`openShellInspector` respects the one-process-one-view rule from the spec:

```tsx
  const openShellInspector = (shell: OrchestratorShell) => {
    const plan = shellTerminalPlan(project?.terminals ?? [], shell, (ptyId) =>
      useTerminalsStore.getState().byPtyId[ptyId]?.alive ?? false,
    )
    if (plan.action === 'reuse') {
      openShellTerminal(shell)
      return
    }
    setInspecting({ kind: 'shell', id: shell.id })
  }
```

and `openShellTerminal` closes the panel first: add `setInspecting(null)` as its first line.

Render the inspector at the end of the pane's JSX (inside the pane `section`, after the split), resolving the target from live state so it updates on every snapshot:

```tsx
      {inspectorTarget && (
        <OrchestratorInspector
          target={inspectorTarget}
          projectId={projectId}
          theme={theme}
          terminalTheme={terminalTheme}
          diffText={diffText[inspectorTarget.kind === 'worker' ? inspectorTarget.job.id : '']}
          diffLoading={diffLoading.has(
            inspectorTarget.kind === 'worker' ? inspectorTarget.job.id : '',
          )}
          shortcuts={shortcuts}
          shellBusy={
            inspectorTarget.kind === 'shell' ? shellBusy.has(inspectorTarget.shell.id) : false
          }
          canStopJob={inspectorTarget.kind === 'worker' && canStop(inspectorTarget.job)}
          onClose={() => setInspecting(null)}
          onLoadDiff={(jobId) => void toggleDiff(jobId)}
          onStopJob={(jobId) => void stopJob(jobId)}
          onShortcut={(job, shortcut) => void sendShortcut(job, shortcut)}
          onShellControl={(shell, control) => void controlShell(shell, control)}
          t={t}
        />
      )}
```

with

```tsx
  const inspectorTarget = useMemo((): InspectorTarget | null => {
    if (!inspecting) return null
    if (inspecting.kind === 'worker') {
      const job = jobById.get(inspecting.id)
      return job ? { kind: 'worker', job } : null
    }
    const shell = shellById.get(inspecting.id)
    return shell ? { kind: 'shell', shell } : null
  }, [inspecting, jobById, shellById])
```

`toggleDiff` currently toggles; the inspector wants "load it if it is not loaded". Split it: keep a `loadDiff(jobId)` that fetches when `diffText[jobId]` is undefined, and drop the open/closed state (`diffOpenFor`), which the tab replaces.

- [ ] **Step 7: Stop and shortcut handlers**

```tsx
  const stopJob = async (jobId: string) => {
    try {
      await orchestratorCancelJob(jobId)
    } catch (error) {
      pushToast({
        title: t('orchestrator.stopFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // The instruction is typed into the planner's input and left there: the person edits it and sends.
  const sendShortcut = async (job: OrchestratorJob, shortcut: OrchestratorShortcut) => {
    const target = job.plannerId ? findPlannerTerminal(projects, job.plannerId) : null
    const alive = job.plannerId
      ? (useTerminalsStore.getState().byPtyId[job.plannerId]?.alive ?? false)
      : false
    if (!target || !alive || !job.plannerId) {
      pushToast({ title: t('orchestrator.noPlannerForShortcuts') })
      return
    }
    setInspecting(null)
    openTerminalWorkspace(target.projectId, target.terminalId)
    setActiveTerminal(target.projectId, target.terminalId)
    requestPaneFocus(target.terminalId)
    setActiveView('workspace')
    await writePtyChunked(job.plannerId, renderShortcut(shortcut, job, project?.defaultCwd ?? null), true)
  }
```

`writePtyChunked` comes from `../XTermView/terminalWrite`; it wraps the text in bracketed-paste markers and sends no Enter, which is exactly what the spec asks for.

Hide the shortcuts for a worker whose planner is gone: compute `const plannerAliveFor = (job) => …` once and pass `shortcuts` as `[]` for those jobs, so the hover bar and the inspector agree.

- [ ] **Step 8: Remove the rail section**

Delete the `ShellsSection` component and both of its usages (the rail at ~line 1796 and the empty state at ~line 1486). The empty state goes back to just the `empty` block. Delete the `ShellCard` import and the three `ShellCard.*` files. Remove any CSS rules in `OrchestratorPane.module.css` that only the deleted section used (search each class name before deleting it).

- [ ] **Step 9: Add the locale strings**

`en.ts` (+ pt-BR): `'orchestrator.shellsEyebrow': 'shells'`, `'orchestrator.shellsLabel': 'Shells'`, `'orchestrator.shellsOrphanLabel': 'Shells with no agent'`, `'orchestrator.shellCount': '{count} shell(s)'` (follow the pluralisation style the neighbouring keys use), `'orchestrator.stopWorker': 'Stop this worker'` (if Task 7 did not already add it), `'orchestrator.stopFailed': 'The worker did not stop'`, `'orchestrator.shellNodeTitle': 'Open this shell'`.

- [ ] **Step 10: Verify**

Run: `npm test` → PASS (delete-or-adapt any test that referenced the removed worker detail strip or `ShellCard`)
Run: `npm run build` → exit 0

- [ ] **Step 11: Stage**

```bash
git add src/components/OrchestratorPane src/lib/i18n/messages
```

---

### Task 9: Changelog and the whole-suite pass

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Write the changelog entries**

Under `## [Unreleased]` → `### Changed` (create the heading if it is not there), in the voice the file already uses — user-facing, no internals:

```markdown
- **Shells the lead agent starts now live on the orchestration board, next to the agent that opened
  them.** A `docker compose up` or a dev server appears as its own card, joined by a line to the
  agent that asked for it, with stop, restart, run again, open terminal and remove on hover. A shell
  whose agent you closed stays on the board in its own group, so nothing keeps running out of reach.
  The old Shells list in the side rail is gone.
- **Clicking a worker, a subagent or a shell now opens a panel over the board instead of stretching
  its card.** The panel has room for the whole report, a tab with the full diff, and — for a shell —
  its live terminal, in colour, that you can type into.
- **The buttons on a worker became instructions you send to the lead agent.** Apply, Review and
  Continue write a ready message into the lead's terminal, where you edit it before pressing Enter.
  You can change their wording, or add your own, in Preferences → Multiagent.
```

- [ ] **Step 2: Run everything**

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator
```

All four must pass (the two `Permission denied` lines from the orchestrator test are pre-existing noise).

- [ ] **Step 3: Stage**

```bash
git add docs/CHANGELOG.md
```

---

## Manual verification (owner, after the tasks)

Not a task for an implementer — the app must not be started by one. The owner checks, on the new board:

1. The planner opens a shell; the card appears under a "Shells" group joined to the planner.
2. Hover shows the controls; stop sends Ctrl+C to `npm run dev` and to `docker compose up`.
3. A command that fails at once shows `exited` with its code, and the panel shows the error text.
4. Closing the planner's terminal leaves the shell on the board in the orphan group.
5. Restart the app, press play, then open the panel: the terminal attaches and shows live output.
6. Clicking a worker opens the panel; the report reads well and the Diff tab shows the whole diff.
7. Apply on an isolated finished worker lands the message in the planner's input, unsent.

# Orchestrator Roadmap

This is a separate, focused roadmap for the MCP-delegate orchestrator (`orchestrator_core.rs`,
`OrchestratorPane`) — the planner-calls-`alethe_delegate`, real-process, forest-canvas system built
directly. It intentionally does **not** merge with [`ROADMAP.md`](ROADMAP.md), which describes a
different, task-DAG-first orchestration effort (`scheduler.rs`, GSD-fed, pull-based dispatch) that
exists in the codebase but is currently disconnected. The two overlap in ambition — both explicitly
reject vendor lock-in — but differ in shape enough that reconciling them is its own future decision,
not assumed here.

Status uses percentages per phase, computed as checked items / total items in that phase's list.
Update the checklist as work lands; update the percentage alongside it in the same commit.

---

## Product thesis

The orchestrator's differentiation is not "a board that shows agents running" — that is now a
contested category (Devin Desktop's Agent Command Center, OpenAI's Codex app, Cursor's 8 parallel
agents). Alethe's edge is **managing several agents from different vendors so you never run out of
usage**, and steering work to whichever tool is actually the right (and cheapest) fit. That pain is
real and documented: Claude Code's 5-hour + weekly caps, Codex's own plan caps, and a third-party
tool (CAAM) that exists solely to swap CLI accounts on limit. No major competitor manages usage
*across* vendors today.

## Current state (baseline)

| Capability | State |
|---|---|
| Claude as planner (calls `alethe_delegate`) | Shipped |
| Codex as worker (spawned, steerable, approvable) | Shipped |
| Codex as planner (delegates to another Codex) | Unverified — never tested this session |
| Claude as worker (executes delegated work) | Backend implemented and unit-tested (fake CLI) — not yet run end-to-end against the real `claude` binary in the app |
| Native subagents (Claude + Codex) on the board | Shipped |
| Background shells (`run_in_background`) on the board | Shipped (Claude only; Codex not wired) |
| Diff viewer inline on a worker's card | Shipped |
| Board scoped per project | Shipped |
| Worker approval (asks before leaving its sandbox) | Shipped |
| Native web search for Codex workers | Shipped |
| Usage/quota awareness inside the orchestrator | Shipped (v1) — warning chip in the header, no redirect action yet |
| Cost/pricing-aware delegation (registry + guardrail) | Not started — Phase 5 |
| Apply an isolated worktree back to the branch | Shipped — clean/no-conflict path only |
| Rich media on the canvas (images, embedded pages) | Shipped (v1) — image inline, link opens a pane |

---

## Phase 1 — Claude as a worker (close the Claude↔Codex pair)

**Goal**: either side can be planner or worker. Today Claude can only ask; it can never be asked.

**Verified live this session** (not assumed): `claude -p --input-format stream-json
--output-format stream-json --permission-mode <mode>` is a long-lived, multi-turn, bidirectional
process — architecturally the same shape as Codex's app-server, not a one-shot call.
- Input line: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
  — confirmed working on the first try, no `--resume` needed between turns.
- `init` event repeats per turn (not just once) and carries `session_id`, `capabilities:
  ["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]` — an interrupt/steer
  path exists; exact control-message shape is still unknown.
- `rate_limit_event` is emitted per turn with `rateLimitType`, `resetsAt`, `status` — this doubles
  as free, real-time input for Phase 2, no separate poll needed for the Claude side.
- The terminal `result` event carries `total_cost_usd`, full `usage` (incl. cache tokens),
  `permission_denials`, `terminal_reason` — richer telemetry than what is captured from Codex today.

**Also verified — a real constraint, not just an unknown**: the raw CLI's stream-json mode has
**no interactive approval channel**. A tool call needing permission does not pause and wait; it is
auto-denied, surfaced as `{"type":"system","subtype":"permission_denied","tool_name","tool_use_id",
"message"}`, and the turn just continues (the model gets told and reports it in its final text).
There is no `requestApproval`-style pause/answer exchange like Codex's app-server has. Two real
options, not yet decided:
- Run Claude workers with `bypassPermissions` (or `--dangerously-skip-permissions`) — simplest, but
  gives up the "asks before leaving its sandbox" symmetry Codex workers already have.
- Use the actual Claude Agent SDK (TypeScript/Python), which exposes a `canUseTool` callback for
  real interactive approval — but that means a small sidecar process talking to Rust over stdio
  (same shape as the Codex-hooks-forwarder script already built), not just spawning the bare CLI.

**Checklist**
- [x] Validate Claude's headless multi-turn protocol empirically (probe script, this session)
- [ ] Find and validate the interrupt/steer control-message shape (`interrupt_receipt_v1` etc.)
- [x] Find and validate how approval/sandbox works in this mode — done: **no interactive approval
      channel exists over the raw CLI's stdio**, only auto-deny + report. Decided: ship v1 with
      `bypassPermissions` (matches Codex's own default-permissive behavior — approval there is
      opt-in per delegate call, not always-on); an SDK sidecar for real approval parity is a later
      upgrade, not a blocker.
- [x] Abstract `Job`/`spawn_worker` in `orchestrator_core.rs` into a per-`agent` backend dispatch —
      `Core.launchers` is now a map keyed by `Launcher::kind` (was a single `Option<Launcher>`);
      `spawn_worker` looks up by `job.agent` and branches its handshake (Claude: no
      `initialize`/`thread/start`, the first stdin line is the first turn) and its reader loop
      (`on_worker_message_claude` vs. the existing Codex-shaped `on_worker_message`).
- [x] Implement the Claude backend: spawn ✓, send message ✓ (`alethe_send` writes the next turn
      directly to stdin when idle), steer ✓ (queues for the next turn — see note above, true
      mid-turn interrupt stayed unverified after a probe-environment hiccup, not attempted blind),
      read tokens/cost ✓ (`result.usage`), resume after restart ✓ (`--resume <session_id>`),
      answer an approval request — **not applicable**, no live channel exists (see above),
      graceful shutdown ✓ (reuses existing `teardown()`), diff ✓ (no `turn/diff/updated`
      equivalent exists, so a plain `git diff HEAD` in the worker's `cwd` runs after each turn
      instead — silently skipped when `cwd` isn't a git repo or has no commit yet).
- [x] Rust tests for the Claude backend alongside the existing 15 in `tests/orchestrator.rs` — 3
      added (`a_claude_worker_reports_its_result_and_tokens`,
      `a_claude_worker_picks_up_its_own_uncommitted_changes_as_a_diff`,
      `delegating_to_an_unconfigured_agent_fails_cleanly_like_any_other_agent`), using a fake
      `cmd /c type <transcript>` launcher instead of the real CLI, so they cost no API usage. 18/18
      passing (`--test-threads=1`; one pre-existing test, `the_observer_sees_every_state_change`,
      is flaky under the default parallel runner — confirmed unrelated to this change, passes
      alone and single-threaded).
- [x] A Codex planner can target a Claude worker — `codex_mcp_config_write` (`agent_events.rs`)
      registers a Codex terminal as a planner and points `.codex/config.toml`'s
      `[mcp_servers.alethe]` at a generated stdio-to-http bridge script (Codex's MCP client only
      declares servers via `command`/`args`, confirmed by the pre-existing `graphify` integration
      using the same shape). Wired into `useXtermSession.ts` alongside the existing hooks wiring.
      Not yet run against a real Codex terminal — the bridge script's behavior is inferred from the
      public MCP stdio transport spec (newline-delimited JSON, no framing), not from a CLI-specific
      probe like the rest of this phase.
- [ ] Manual end-to-end test in the DEV build — covers both the Claude-worker backend and the
      Codex-planner bridge, still pending a real run

**Phase progress: 6/8 (75%)**

## Phase 2 — Quota awareness (Claude ↔ Codex)

**Goal**: notify, don't auto-switch yet (decided). Surface remaining headroom where you're already
looking, with a one-click way to send new work to the other side.

Reuses what already exists and works, currently stranded in the abandoned `AgentCanvasPOC` pane:
`getClaudeUsage`, `getCodexUsage` (`src/lib/tauri/usage.ts`), and the threshold logic in
`useUsagePolling.ts` (`USAGE_FALLBACK_THRESHOLD`, `USAGE_POLL_MS` in `lib/agentCanvasConfig.ts`).

**Correction to the plan above**: the live `rate_limit_event` does NOT carry a percentage — only
`status` (`allowed`/`rejected`), `rateLimitType` and `resetsAt`. It is a coarse "did this turn get
through" signal, not the proactive "you're at 85%" signal the goal above wants. Polling
`getClaudeUsage` is still needed for that; the live event is a useful bonus (see below), not a
replacement.

**Checklist**
- [x] Capture `rate_limit_event` from the live Claude worker stream (Phase 1) onto its `Job` —
      `Job.quota`, surfaced in the snapshot. Doubles as a plain-language explanation on a job that
      failed specifically because it got rate-limited, not some other error.
- [x] Poll `getCodexUsage` (and `getClaudeUsage`, per the correction above) — new hook
      `useOrchestratorQuotaWarnings` (`src/hooks/`), same poll cadence as the old
      `useUsagePolling.ts` (`USAGE_POLL_MS`/`USAGE_FALLBACK_THRESHOLD`), living in the real
      orchestrator pane instead of the abandoned POC.
- [x] Warning UI on the planner's tab/card in `OrchestratorPane` — a chip in the header next to the
      existing blocked/interrupted counts (reuses `.countAlert`'s base style, not a PTY-injected
      message like the old prototype).
- [ ] Quick action: "send new work to the other side" from the warning — scoped out of this pass on
      purpose: the composer targets a specific job, not a planner, and a half-built redirect action
      risked being more confusing than the plain warning text alone. Revisit once it's clear this
      warning gets used in practice.
- [ ] Manual test forcing high usage on one side

**Phase progress: 3/5 (60%)**

## Phase 3 — Antigravity

Same two-part shape as Phase 1+2, for Antigravity. Biggest unknown: its programmatic/headless
protocol has not been probed at all yet — needs the same empirical treatment Codex and Claude
already got, not an assumption. `get_antigravity_usage` already exists for the quota half.

**Checklist**
- [ ] Probe Antigravity's CLI for a headless/programmatic mode (does it have one at all?)
- [ ] Validate its event/turn protocol empirically
- [ ] Backend implementation in `orchestrator_core.rs`
- [ ] Planner-side wiring (however Antigravity accepts MCP servers, or an equivalent bridge)
- [ ] Wire `get_antigravity_usage` into the Phase 2 warning UI
- [ ] Manual end-to-end test

**Phase progress: 0/6 (0%)**

## Phase 4 — OpenCode

Same shape again. OpenCode already has partial integration in Alethe (MCP config writers,
GSD hooks) — worth mapping what's reusable before writing anything new.

**Checklist**
- [ ] Map existing OpenCode integration points (`aiMemoryOpenCodeConfigWrite`,
      `graphifyOpenCodeConfigWrite`, GSD plugin) for reuse
- [ ] Probe OpenCode's headless/programmatic protocol
- [ ] Backend implementation in `orchestrator_core.rs`
- [ ] Planner-side wiring
- [ ] Wire `get_opencode_usage_summary` into the Phase 2 warning UI
- [ ] Manual end-to-end test

**Phase progress: 0/6 (0%)**

## Phase 5 — Cost-aware delegation (Claude ↔ Codex)

**Why this phase, why now**: the product thesis above already names this the differentiator —
"steering work to whichever tool is actually the right (and cheapest) fit" — but nothing built
toward it exists yet. Phase 2 shipped detection and explicitly deferred action ("notify, don't
auto-switch yet (decided)"), with its own stated reopening condition: "only after Phase 2's
detection proves reliable in practice." This phase is that reopening — staged, not a jump straight
to silent auto-switch, because the one precedent already in this codebase for "tell an LLM to route
by cost" is unenforced and unreliable by design: `orchestrationRules()`'s prose instruction "prefer
offloading to a codex worker when Claude usage is high" is trust-only, lives in the abandoned
`AgentCanvasPOC` path, and nothing verifies a planner actually follows it. Scoped to Claude and Codex
only, because they are the only two agents with a live rate-limit/usage/plan signal wired today
(Phase 1's `rate_limit_event` → `Job.quota`, `getClaudeUsage`'s `five_hour.utilization`,
`getCodexUsage`'s `primary.used_percent` + `rate_limited` + `plan`). Every other agent is Phase 6.

**Builds on**: Phase 1 (Claude backend, live `rate_limit_event`) and Phase 2 (`getClaudeUsage`/
`getCodexUsage` polling, `useOrchestratorQuotaWarnings`). Does **not** touch `scheduler.rs` or
`ROADMAP.md`'s own Phase 5 ("Policy") — that phase is explicitly gated behind that document's
Phases 1-4 (task model, delegation, supervision, landing) being real first, and they are not. Both
documents converge on the same ambition ("agent selection by... cost") from opposite ends; that
reconciliation is a future decision, not assumed here (a pointer is left in `ROADMAP.md`).

**A constraint this design has to respect**: `orchestrator_core.rs` is deliberately "free of Tauri
and of anything else in this crate" (its own module doc comment) so `tests/orchestrator.rs` can
compile it standalone. `getClaudeUsage`/`getCodexUsage` are `#[tauri::command]`s living in the full
crate — `alethe_delegate`'s handler cannot call them directly without breaking that boundary. The
fix reuses the shape `Core.launchers` already uses: the app layer pushes state in, the core never
reaches out for it. Concretely: a new `Core::set_agent_fitness(agent, snapshot)` alongside the
existing launcher map, filled by a small Tauri command that the existing
`useOrchestratorQuotaWarnings` poll loop calls right after each `getClaudeUsage`/`getCodexUsage`
round — the same cadence (`USAGE_POLL_MS`), not a second poll.

**Pieces**:
- **Pricing/plan/free-tier registry** — `src/lib/agentPricing.ts`, shaped like
  `AGENT_INSTALL_CATALOG` (`Partial<Record<AgentType, AgentPricingEntry>>`): plan name(s), monthly
  price, free-tier terms, a short human description of what "cheap right now" means for that vendor
  (a flat-rate plan reads differently from pay-per-token). Each entry carries a `lastVerified` date
  and `sourceUrl` — the existing per-token `pricing_for()` table in `agent_cost.rs` has no such
  field, and nothing today flags a stale number when a vendor changes its pricing. Populated for
  `claude` and `codex` only in this phase; every other agent is left absent on purpose, same as
  `AGENT_INSTALL_CATALOG` already leaves gaps it doesn't cover.
- **Live "cheap/available now" signal** — a small struct (`rate_limited: bool`,
  `used_percent: Option<f64>`, `plan: Option<String>`) derived from the two usage polls above,
  pushed into `Core` as described. Deliberately a raw signal, not a single computed "score" the
  planner has to trust blind — the guardrail below is what interprets it.
- **Enforcement, not prose** — `alethe_delegate`'s handler reads the fitness snapshot for the
  requested `agent` at call time, in two stages:
  - **Suggest-only (ships first, no preference required)**: when the requested agent is
    rate-limited or past a fixed threshold (reuse `USAGE_FALLBACK_THRESHOLD = 80`) and the other of
    the pair is not, the tool's JSON *result* — not just its static description — carries a
    `costHint` naming the cheaper alternative and why, grounded in the polled number the planner
    cannot independently see, not a string it has to take on faith. This is the literal graduation
    of Phase 2's warning: from "sits in the header, the planner never sees it" to "sits in the
    planner's own tool-call loop."
  - **Opt-in auto-switch (behind a preference, default off)**: only once suggest-only has run for a
    while and the signal has proven itself — mirrors Phase 2's own reopening bar. When enabled, and
    the requested agent is exhausted while the other is fully available, the handler substitutes
    the agent server-side and returns `{"rerouted": true, "from": ..., "to": ..., "reason": ...}` in
    the same response shape `alethe_delegate` already returns — visible, not silent, logged like any
    other job.
- **Tool-schema hint, kept static and small** — extend the `agent` property's description in
  `tools()` (`orchestrator_core.rs:1334-1338`) with one clause naming the general cost shape of each
  agent, same category as the existing "A Claude worker runs without an approval channel" sentence.
  Kept static on purpose: whether `tools/list` is re-polled every turn by a given MCP client (Codex's
  and Claude's own re-fetch cadence for a live session) is unverified, not assumed — live numbers
  belong in the delegate *response* above, not baked into a description that can go stale mid-session.
- **Claude-side lever worth evaluating: Anthropic Managed Agents** — the "plan big, execute small"
  cookbook pattern (`claude-cookbooks/managed_agents/CMA_plan_big_execute_small.ipynb`) is a native,
  off-the-shelf version of part of this phase: a `multiagent` coordinator with no tools of its own
  delegates to cheap worker models, backed by a real **enforced** session
  `budget: {"type":"limit","max_list_cost":{...}}` that pauses the whole team instead of running
  unbounded, and typed per-thread `usage.list_cost` — i.e. real-time cost metering and a hard spend
  cap, built into the API, for free, on the Claude side specifically. Worth evaluating as a narrower
  upgrade path for routing read-heavy/mechanical *sub-tasks* to a cheap model automatically — the
  same intent as `economy_agents.rs`'s static `haiku-resumidor`/`haiku-mecanico` prompts, but
  enforced by Anthropic's own budget mechanism instead of a hand-authored prompt trusting
  compliance. **Not a drop-in replacement for Phase 1's CLI-based Claude worker**, and not asserted
  as the right call here: Managed Agents sessions run in Anthropic's own cloud environment
  (`environments.create(config={"type": "anthropic_cloud"})`), which conflicts with `ROADMAP.md`'s
  own explicit non-goal ("No hosted orchestration. Everything stays local-first") and with the
  visible/take-over-able local terminal promise Phase 1's Claude worker already provides. Scope as
  an opt-in prototype to evaluate, not a commitment.
- **Consent** — a new orchestrator preference, off by default: "let Alethe redirect work to a
  cheaper agent automatically." Not folded into an existing on-by-default toggle — auto-switch
  changes which vendor sees a user's code and prompts for a given task, a decision the user should
  make explicitly, not one this phase makes for them.

**Checklist**
- [ ] `agentPricing.ts` registry — Claude + Codex entries only, each with `lastVerified` + `sourceUrl`
- [ ] `AgentFitness` computation + `Core::set_agent_fitness` push path (new Tauri command +
      `useOrchestratorQuotaWarnings` wiring), respecting the crate-free boundary above
- [ ] `alethe_delegate`'s result carries `costHint` when the requested agent is worse off than the
      alternative (suggest-only, no preference gate)
- [ ] Preference toggle for opt-in auto-switch, off by default
- [ ] `alethe_delegate` performs the substitution and returns `rerouted` when the preference is on
      and the requested agent is exhausted
- [ ] Extend the `agent` property's schema description in `tools()` with the static per-agent
      cost-shape hint
- [ ] Verify how often each supported MCP client actually re-requests `tools/list` in a live
      session — decides whether the static hint above is worth keeping past this phase
- [ ] Evaluate Anthropic Managed Agents (`multiagent` coordinator/worker, enforced
      `budget.max_list_cost`, real per-thread `usage.list_cost`) as a prototype for routing
      read-heavy/mechanical delegated sub-tasks to a cheap Claude model — resolve the local-first/
      cloud-environment tension above before deciding to build on it
- [ ] Manual test: force one side into rate-limit, confirm the hint appears, then confirm a real
      reroute with the preference on

**Phase progress: 0/9 (0%)**

## Phase 6 — Cost-aware delegation, remaining agents

Same shape as Phase 5, one agent at a time, each gated on that agent having a live rate-limit/usage
signal at all. Today only Claude, Codex and Antigravity have one (`get_antigravity_usage`) — and
Antigravity has none of Phase 3's worker-backend wiring yet, so its fitness signal can exist before
it can ever be a valid `alethe_delegate` target. Kiro, OpenCode, Copilot, Mimo and Freebuff have
neither a usage signal nor a worker backend today; each needs its own detection work first, the same
empirical-probe shape Phase 3/4 already use for backend wiring — this is not a batch of registry
entries, it is five small research passes.

**Checklist**
- [ ] Antigravity: wire `get_antigravity_usage`'s `used_percent`/`rate_limited`/`status` into the
      Phase 5 fitness signal — blocked on Phase 3 shipping a worker backend before the delegate
      guardrail can act on it, even though the signal itself can be wired earlier
- [ ] Antigravity: pricing/plan/free-tier entry in `agentPricing.ts`
- [ ] OpenCode: usage/rate-limit polling — nothing exists today beyond `agent_cost.rs`'s local
      SQLite cost read, which is historical spend, not live quota; needs its own probe, same as
      Phase 4's own headless-protocol item
- [ ] OpenCode: pricing/plan/free-tier entry — complicated by OpenCode itself routing multiple
      providers/models, so "OpenCode's price" may be per-underlying-model rather than one number;
      resolve before assuming the same `AgentPricingEntry` shape fits unchanged
- [ ] Kiro: usage/rate-limit polling — no existing code to build on, the first from-scratch probe
      of this set
- [ ] Kiro: pricing/plan/free-tier entry
- [ ] Copilot: usage/rate-limit polling
- [ ] Copilot: pricing/plan/free-tier entry
- [ ] Mimo: usage/rate-limit polling
- [ ] Mimo: pricing/plan/free-tier entry
- [ ] Freebuff: usage/rate-limit polling
- [ ] Freebuff: pricing/plan/free-tier entry
- [ ] Extend `alethe_delegate`'s `agent` enum and the guardrail logic to cover whichever of the
      above already has a worker backend by the time this lands

**Phase progress: 0/13 (0%)**

---

## Track — Apply worktree back to its branch (shipped)

Closes the loop an isolated (`isolate: true`) job otherwise left open: you could see the diff, but
landing it meant leaving Alethe for raw git. Reconciled in two parts:

- **Rust**: `isolate_worktree` in `orchestrator_core.rs` now creates worktrees at the exact same
  path/branch convention `worktrees.rs`'s RFC-003 manager already uses
  (`<repo>/.alethe/worktrees/<job_id>/`, branch `alethe/agent-<job_id>`, was
  `<parent>/.alethe-worktrees/...` on a **detached** HEAD — no branch at all, so a worker's commits
  were only reachable by SHA). `orchestrator_core.rs` stays crate-free on purpose (so
  `tests/orchestrator.rs` can compile it standalone) — reconciliation is by on-disk convention, not
  by calling `worktrees.rs` directly.
- **Frontend**: an "apply" button on a finished isolated job's card
  (`OrchestratorPane/index.tsx`) runs `worktreeCommitWorktree` → `worktreeFetchBranch` →
  `mergeAnalyze` → (if clean) `mergePrepare` → `mergeFinalize` → `worktreeRemove`. All plain,
  already-tested Tauri commands, called directly — no dependency on `mergeStore.ts` or the Merge
  Center UI. Scoped to the clean/no-conflict path only; anything else surfaces a toast asking for
  manual resolution (building conflict-resolution UI for orchestrator jobs specifically is its own,
  separate scope).

## Track — Rich media on the canvas (v1 shipped)

Resolved the open trigger question by not needing one tied to a specific tool: instead of hooking
into each backend's own tool-call shape (which differs between Codex and Claude and would miss
native subagents/background shells entirely), `extractMediaItems`
(`src/lib/orchestratorMedia.ts`) scans a worker's plain-text report for a local image path or a URL
— the one signal every job already produces regardless of backend. A local image renders inline via
`convertFileSrc` (the same mechanism `FileExplorer.tsx` already uses for its own preview); an image
URL renders inline directly; a plain link is a small button that opens it in a real pane via
`createWebPane` — reusing the exact mechanism `useAgentBrowserOffers.ts` already uses for pages an
agent opens live, just triggered from report text instead of a live browser event.

Deliberately NOT done (scope cut, not an oversight): a link opens in its own pane on click rather
than rendering inline in the card itself — an inline live embed (iframe-equivalent) inside a small
card was judged too likely to go wrong blind, given no existing precedent in this codebase renders
a live page inside a compact card rather than a full pane.

## Track — Canvas UI improvements

Fixed: dragging on the canvas triggered the browser's native text-selection drag instead of (or
fighting) the pane's own pan handling — `user-select: none` on `.board`
(`OrchestratorPane.module.css`) now keeps the pointer handlers in `index.tsx`
(`startPan`/`movePan`/`endPan`) the only thing that reacts to a drag there.

Otherwise explicitly parallelizable with the phases above — flagged as important, not yet
itemized beyond the drag fix above. Revisit
once there is a concrete list (this session already made several passes on the canvas: forest
layout, planner tabs, subagent/background branches, diff viewer inline — next round of complaints
or ideas should land here before being built).

## Open ideas — what else would help

Space for brainstorming beyond the phases above. Nothing here is committed.

- (placeholder — fill in as ideas come up in discussion)

---

## Explicitly out of scope for now

- ~~Automatic switching on quota exhaustion~~ — **superseded by Phase 5**: staged as a `costHint` in
  `alethe_delegate`'s own response first (no preference needed), with the actual switch itself
  behind an explicit opt-in preference, never a silent default. Still gated on Phase 2's detection
  having run in practice, per this same condition — Phase 5 doesn't skip that bar, it is what acts
  once it's cleared.
- **CAAM-style multi-account rotation within one vendor** — a different axis from cross-vendor
  routing, touches credential switching, needs its own study.
- **A generic model router (OpenRouter/LiteLLM-style)** — hypothesis is that OpenCode (Phase 4)
  already covers this once it's a backend, since it routes multiple providers/models on its own.
  Don't build a duplicate inside Alethe without confirming a real gap first.
- ~~Applying an isolated worktree back to its branch~~ — **done**, see "Track — Apply worktree"
  below. Turned out not to need `mergeStore.ts` at all — its underlying Tauri commands
  (`mergeAnalyze`/`mergePrepare`/`mergeFinalize`) are plain functions with no dependency on a
  `Terminal` entity, unlike the Merge Center UI itself (its card list is keyed off terminals that
  carry a `worktreeAgentId`, which a delegated job never has).

## Verification, every phase

- `cargo check` + `cargo test --test orchestrator` (15 tests today — must not regress; each new
  backend gets its own tests in the same file).
- `npx tsc --noEmit -p .` (also validates i18n).
- `npx vitest run` (436 tests today).
- A real manual end-to-end test in the DEV build — never mark a phase done on green tests alone,
  this session's history (approval flow, Codex hooks, Codex web search) shows the CLI's real
  behavior repeatedly diverges from its own docs.
- `docs/CHANGELOG.md` under `[Unreleased]`, same task as the phase that shipped.

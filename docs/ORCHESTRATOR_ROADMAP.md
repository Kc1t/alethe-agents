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
| Worker personas (planner / brainstorm / executor) | Not started — Phase 7 |
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
  ["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]` — the control-message
  shape behind these is now known and validated live, see the checklist item below.
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
- [x] Find and validate the interrupt/steer control-message shape (`interrupt_receipt_v1` etc.) —
      read out of the CLI binary's own embedded schema, then confirmed against the real `claude`
      process in two live probes. **There is no mid-turn steer**: the only control message a running
      turn accepts is `interrupt`, so Codex's `turn/steer` has no counterpart and never will on this
      transport. The equivalent is queue-then-interrupt, which is what shipped.
      - Request, written on the worker's stdin like any other stream-json line:
        `{"type":"control_request","request_id":"<string>","request":{"subtype":"interrupt",
        "cancel_queued":false}}`. `request_id` is a free-form string, **not** required to be a UUID
        (probed: `"job-07-interrupt-3"` was echoed back verbatim), so no `uuid` crate was needed.
      - Response, ~90ms later: `{"type":"control_response","response":{"subtype":"success",
        "request_id":"<same>","response":{"still_queued":[...],"cancelled":[...]}}}`. The error form
        is `{"subtype":"error","request_id":"<same>","error":"<message>"}`.
      - `interrupt_receipt_v1` is what puts `still_queued` on that payload — the uuids of async user
        messages that survive the abort and *will* run. `interrupt_cancel_queued_v1` is what honours
        `cancel_queued:true`, which kills them instead and lists them under `cancelled`
        (probed: `still_queued: []`, `cancelled: ["alethe-job-07-steer-1"]`).
      - The aborted turn still emits a normal `result`. Its `terminal_reason` comes from the
        `interrupted`/`aborted_streaming`/`aborted_tools`/`cancelled` family, but which one is not
        worth guessing at, so the job carries an `awaiting_steer` flag instead and the `result` that
        only acknowledges an interrupt Alethe itself asked for is not reported to the planner as a
        finished turn.
      - Shipped on top of this: `alethe_steer` on a running Claude worker pushes the correction to
        the front of the inbox and interrupts, so `finish_turn` hands it straight back as the next
        turn; `alethe_cancel` sends the same request with `cancel_queued:true` instead of the Codex
        `turn/interrupt` JSON-RPC, which a Claude worker never understood.
      - Covered by two new Rust tests (a running worker is interrupted, an idle one still queues).
        The no-announce path on the aborted `result` is **not** unit-covered — the fake CLI replays a
        fixed transcript and cannot be interrupted — so it rides on the manual end-to-end test below.
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
      passing (24 across the suite after this session's additions; `--test-threads=1`; one pre-existing test, `the_observer_sees_every_state_change`,
      is flaky — confirmed unrelated to this change). **Correction, observed since:** it is flaky
      under `--test-threads=1` too, not only under the default parallel runner — it failed and then
      passed on consecutive single-threaded runs of the same code. Single-threaded is not a reliable
      workaround; a green run does not prove it fixed, and a red one does not prove a regression.
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

**Phase progress: 7/8 (87%)**

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

## Phase 5 — Headroom-aware delegation (Claude ↔ Codex)

**The signal is remaining limit, not money (decided).** This phase was drafted as "cost-aware" and
that framing was wrong. What decides where work goes is how much of each vendor's window is left and
when it resets — the same numbers `UsageStrip.tsx` already renders for the human. Spend in dollars
is a separate, optional nicety and no part of the routing decision.

**Compare the binding window, never a fixed one (decided).** Claude reports three windows
(`five_hour`, `seven_day`, `seven_day_opus`), Codex reports two (`primary`, `secondary`). A real
reading shows why the shapes cannot be compared field-by-field:

| | 5h | week | opus |
|---|---|---|---|
| claude | 20% | 19% | 0% |
| codex | 22% | **60%** | — |

On the 5-hour window they are tied (20 vs 22) and the choice looks arbitrary. On the week, Codex is
three times closer to its ceiling. Codex is the one running out, and the 5-hour window hides it
completely. So "running out" means *the worst window that agent has*, and Alethe resolves it before
the planner ever sees it — the planner must not have to know that one vendor has three windows and
the other has two.

**Three bugs only a real reading found (recorded so they are not reintroduced).** The first live
delegation against genuine usage — Codex at 98% of its 5h window, Claude at 80% — broke three
things that 26 green tests had missed, because every test until then set one side strained and the
other rested. Both sides past the threshold at once is the case that matters and the case nobody
wrote:

1. **The board blamed the wrong agent, at random.** `strained_agent` returned the *first* entry past
   the threshold, and the block is built by iterating a `HashMap`, so the order is arbitrary. With
   both sides over 80 the label could read `chosen · claude 5h 80%` on one refresh and
   `ignored · codex 5h 98%` on the next. It now takes the *most* strained, over a sorted iteration.
2. **The hint offered an equally exhausted agent as the way out** — "codex is at 98%; claude is at
   80%" presents 80% as the escape when 80 *is* the threshold. The hint now carries
   `bothStrained` and says so in words.
3. **A rate-limited agent lost to a percentage.** Strain was compared on `used` alone, so an agent
   actively refusing work at 10% beat one at 99%. Rate-limited is not "nearly gone", it is gone, and
   it now outranks any number.

**Notify, do not reroute (decided).** Alethe surfaces the numbers and names which side has headroom;
the planner still chooses. No server-side substitution, no preference toggle, in this phase.

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

**Everything here is derived, never hand-maintained (decided).** An earlier draft of this phase
opened with a static `src/lib/agentPricing.ts` holding plan names, monthly prices and free-tier
terms, each stamped with `lastVerified` + `sourceUrl`. That is cut. The `lastVerified` field was
invented to warn that a hand-written number had rotted — which is an admission that the number
should not have been hand-written. Everything the routing decision needs is already detected:

| Needed | Where it already comes from | Static today? |
|---|---|---|
| Claude headroom | `getClaudeUsage` → `five_hour` / `seven_day` / `seven_day_opus`, each `utilization` + `resets_at` | no |
| Codex headroom | `getCodexUsage` → `primary`/`secondary` `used_percent`, `resets_at_ms`, `rate_limited`, `reset_credits` | no |
| Codex plan name | `getCodexUsage` → `plan` | no — **already auto-detected** |
| Live rate-limit hit | Phase 1's `rate_limit_event` → `Job.quota` | no |
| Per-token rates | `agent_cost.rs`'s `pricing_for()` | **yes — hardcoded, and it must stop being** |

`pricing_for()` (`agent_cost.rs:63`) hardcodes `opus → (5.0, 25.0)` and `sonnet → (3.0, 15.0)` in
Rust. It is the one static number in the chain and it is already the stale one; making it dynamic is
part of this phase, not a separate cleanup.

**Pieces**:
- **Spend, computed rather than declared** — the orchestration's real cost so far, from each `Job`'s
  own `tokens` (already captured, already in the snapshot) times the per-token rate. No subscription
  price table is involved, because the question the planner is actually asking is "what has this run
  cost and what headroom is left", not "what does a Max plan cost per month".
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
- **Awareness rides on every tool response, because it is the only channel that exists** — not just
  `alethe_delegate`'s `costHint`. `alethe_status`, `alethe_check`, `alethe_send` and `alethe_steer`
  all return JSON the planner reads, so each carries the same compact block: per-agent utilization
  and reset time, `rate_limited`, detected plan, and the run's spend so far. `alethe_check` matters
  most — its description already obliges the planner to process every delivery, so that is the one
  response guaranteed to be read.
- **Why not a `tools/list_changed` notification** — settled, do not re-open without changing the
  transport. `handle_mcp_body` is one message in, one response out, served by `tiny_http` over POST
  on the `agent_events` listener: there is **no server→client channel**, no SSE, no stream. So
  `notifications/tools/list_changed` has nowhere to go, and the handshake's
  `"capabilities": {"tools": {"listChanged": false}}` (`orchestrator_core.rs:2057`) is honest rather
  than an oversight. A tool *description* carrying live numbers is therefore a session-start
  snapshot at best and a stale claim at worst — which is exactly why the numbers ride on responses
  instead. Keep the description to the durable shape of each agent (flat-rate vs pay-per-token, the
  existing "runs without an approval channel" register), never a figure.
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
- [x] `worstWindow(agent)` — collapse each vendor's windows to the one closest to its ceiling, so
      the two shapes become comparable and the planner never sees the difference —
      `src/lib/agentFitness.ts` (`claudeFitness` over 5h/week/opus, `codexFitness` over 5h/week),
      4 tests. Carries the detected Codex `plan`; deliberately reports **no** plan for Claude,
      because `UsageStrip.tsx:204` hardcodes `'max · 5x'` rather than detecting it.
- [x] `AgentFitness` computation + `Core::set_agent_fitness` push path — new
      `orchestrator_set_agent_fitness` command, called by the existing
      `useOrchestratorQuotaWarnings` poll at the same `USAGE_POLL_MS`, so the planner and the
      warning chip read one number at one cadence. The core stores it and never reaches out for it,
      keeping this module Tauri-free. **Also fixed the chip itself**: it compared only
      `five_hour`, so a worker exhausted on the weekly window raised no warning at all.
- [x] `alethe_delegate`'s result carries `headroomHint` when the requested agent is past
      `HEADROOM_THRESHOLD` (80, matching the frontend's `USAGE_FALLBACK_THRESHOLD`) or rate-limited
      and the other side is not — naming the agent and the numbers it is grounded in. Renamed from
      `costHint`: the signal is remaining limit, not money.
- [x] Routing trace on the canvas — each worker records *why* it ran on the agent it ran on, and the
      edge from its run carries the reason. Recorded only when one side was actually past the
      threshold, so a board where both agents had room stays unlabelled. Two verdicts: `chosen`
      (the planner went to the side with room) and **`ignored`** (it delegated into the strained
      side while carrying that same reading from every earlier tool response). `ignored` is the
      point of the feature: it is what shows whether notify-only is being obeyed, and therefore
      what the auto-reroute decision should be reopened against. `routing` on the job →
      `GraphEdge.note` (`orchestratorGraph.ts`, untouched by the concurrent plugin work) → an
      absolutely-positioned label at the connector's horizontal run. Rendered as HTML, not SVG
      `<text>`: the canvas `<svg>` is `aria-hidden`, and this label carries real information.
- [x] Every tool response carries the fitness block — injected once in `call_tool`, which now wraps
      `dispatch_tool`, so no handler can forget it and a new tool inherits it. Run-spend in dollars
      is **not** included: the decision reads headroom, and money would reintroduce the rate table
      this phase set out to stop depending on.
- [x] Extend the `agent` property's schema description in `tools()` — kept to the durable shape
      (which windows each vendor meters, and that they are not comparable across vendors) plus a
      pointer at the `fitness` block on every response. No figure appears in it: on this transport a
      description is a session-start snapshot, so a number here would go stale mid-session with no
      way to correct it. A test asserts the description contains no `%`.
- [x] Verify whether a live tool-list update is deliverable at all — **it is not**: the MCP
      transport is request/response only (`tiny_http`, POST, one body in one body out), so
      `notifications/tools/list_changed` has no channel and `listChanged: false` is correct. Live
      numbers therefore ride on tool *responses*, and the item below is capped at the durable
      per-agent shape, never a figure. Supersedes the old "how often does each client re-request"
      question, which only matters if a push existed.
- [x] Evaluate Anthropic Managed Agents as a prototype for routing read-heavy sub-tasks to a cheap
      Claude model — **evaluated: do not build on it for the worker path.** The local-first tension
      does not resolve. `config: {type: "self_hosted"}` exists and moves bash/file/code execution
      into a container we control, but *"the agent loop stays on Anthropic's orchestration layer"* —
      and the orchestration layer is exactly what `ROADMAP.md`'s "No hosted orchestration" rules
      out, so self-hosting moves the half that was never the objection. Tool inputs and outputs
      still flow to Anthropic's control plane either way. Three further costs, any one of which
      would sink it on its own:
      - **No PTY.** A CMA worker has no visible, take-over-able local terminal. That is the promise
        Phase 1's CLI-based Claude worker exists to keep, and the reason it was built rather than
        wrapping an SDK.
      - **A new always-on daemon.** `self_hosted` requires a long-polling `EnvironmentWorker`
        running beside the app, plus a Console-issued environment key per user — a second process
        and a manual credential step in a desktop app that today spawns CLIs and nothing else.
      - **It buys enforcement we just decided against.** Its real advantage over
        `economy_agents.rs` is the *enforced* `budget.max_list_cost` and typed `usage.list_cost`.
        This phase deliberately chose notify-only; a hard spend ceiling is not a capability gap
        today. Revisit only if Alethe ever wants an enforced cap, and then as its own decision.
- [ ] Manual test: force one side past the threshold, confirm the hint names the other side and
      that the worst window is the one being compared

**Phase progress: 8/9 (88%)**

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

## Phase 7 — Base personas (planner / brainstorm / executor)

**Goal**: let delegated work declare what *kind* of thinking it needs, not only which CLI runs it.
Three base personas, shipped as skills, orthogonal to the `agent` axis — any persona can run on any
backend, so this composes with Phases 1-4 instead of competing with them.

**Not scheduled.** Recorded here so the shape is agreed before anyone builds it; it deliberately
sits behind Phases 1, 2 and 5, which are the ones with live work.

**The three personas**

| Persona | Default? | Writes to disk | What it is for |
|---|---|---|---|
| `planner` | Yes | No | Decomposes the request, calls `alethe_delegate`, reconciles what comes back. What the lead agent already does today, made explicit and reusable. |
| `brainstorm` | No | No | Divergent, read-only. Returns options with tradeoffs and an argued recommendation, never an edit. |
| `executor` | No | Yes | One self-contained unit of work, carried to a diff. The closest thing to today's default worker behaviour. |

**Decisions to fix before building**

- A persona is a **prompt preset, not a sandbox**. Only `brainstorm`'s read-only promise is worth
  enforcing mechanically, and the honest way to do it is the existing sandbox machinery, not trust
  in the preset text. Whether Codex and Claude can both be spawned genuinely write-blocked needs the
  same empirical probe Phase 1 used — do not assume the CLI flags do what their docs say.
- `planner` being the default is a **statement about the lead**, not about workers: an undeclared
  `alethe_delegate` call keeps spawning today's worker behaviour, so adding personas cannot silently
  change the meaning of every existing delegation.
- Personas imply defaults on the flags that already exist (`brainstorm` → `webSearch` on, no
  worktree; `executor` → `isolate` on when the repo allows it). Those are defaults the caller can
  still override, never a locked combination.

**Open questions**

- Where the preset is injected per backend — Claude takes an appended system prompt; Codex's
  equivalent is unverified and is the first thing to probe.
- Fixed set versus user-editable. A fixed set ships faster and keeps the `alethe_delegate` schema
  description honest; editable personas are the obvious follow-up request.
- Whether a persona is visible on the canvas card, and whether that is a badge or the card's whole
  visual treatment.

**Checklist**
- [ ] Probe how each backend accepts a system-prompt preset (Claude first, Codex second), the same
      way Phase 1 probed the worker protocol
- [ ] Probe whether a genuinely write-blocked worker is spawnable per backend, for `brainstorm`
- [ ] Define the three presets as skill files, versioned in the repo, English-only
- [ ] `persona` property on `alethe_delegate`'s schema — optional, absent means today's behaviour
- [ ] Carry `persona` onto `Job` and into the snapshot so the UI can read it
- [ ] Apply the per-persona flag defaults, overridable by the caller
- [ ] Surface the persona on the worker's canvas card
- [ ] Rust tests in `tests/orchestrator.rs`, fake-CLI based like Phase 1's
- [ ] Manual end-to-end test in the DEV build, one run per persona

**Phase progress: 0/9 (0%)**

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

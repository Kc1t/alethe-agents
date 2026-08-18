# Roadmap — Real Orchestration

Alethe today is a **workspace**: it runs many agents in parallel and keeps their state alive. It is
not yet an **orchestrator**: nothing decides what each agent should work on, nothing tracks a unit of
work from split to landed, and nothing stops two agents from colliding on the same file.

Most of the machinery for that already exists in the codebase, unwired or hidden. This document is
the honest inventory and the order in which to connect it.

> Status of every item here is **planned**, unless marked otherwise. Nothing in this file is a
> commitment to a date.

---

## What already exists

These are shipped primitives, not aspirations.

| Primitive | Where | State |
|---|---|---|
| Worktree isolation | `src-tauri/src/worktrees.rs` | Shipped — provision, list, lock/unlock, fetch, remove, cleanup |
| Task DAG | `src-tauri/src/scheduler.rs` | Shipped but hidden — `dependencies`, `priority`, `lease_resource`, `assigned_agent_id`, statuses `Pending → Ready → Running → Completed / Failed / Blocked` |
| Dependency + lease resolution | `scheduler.rs` `run_scheduler_tick` | Shipped — blocks on unmet dependencies, assigns and releases resource leases |
| Agent callbacks | `src-tauri/src/agent_events.rs` | Shipped — `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `PreToolUse`, `PostToolUse` over a local hooks endpoint with a token |
| Conversation portability | `src-tauri/src/handoff.rs` | Shipped in 1.6.0 — move a conversation between agents, redacted locally |
| Per-agent capability config | `mcp_agents.rs`, `skills.rs` | Shipped in 1.6.0 — MCP servers and skills, per agent |
| Cost and usage tracking | `agent_cost.rs`, `*_usage.rs` | Shipped — per agent |

**The gap is not primitives. It is that nothing connects them.**

The task DAG is fed only by GSD `.planning/` files and surfaces only in Preferences → Multiagent.
`TeammateIdle` fires into a system that has no pool to dispatch to. Worktrees are created by hand,
per terminal, and are never associated with a task.

---

## The missing stage

A unit of orchestrated work has five stages:

```
split  →  isolate  →  delegate  →  supervise  →  land
```

Alethe covers `isolate` well and `split` partially. `delegate` is manual. `supervise` is per-agent,
never per-run. And `land` was **removed in 1.6.0** along with the Merge Center — it returns in a
later version, and when it does it should come back as the terminal stage of a run, not as a
standalone panel.

That reframing is the spine of this roadmap.

---

## Phase 1 — Own the task model

Today a task only exists if a GSD `.planning/` file describes it. Orchestration cannot be built on a
format owned by a plugin.

- Promote `Task` to a first-class, persisted Alethe entity, versioned in `projects.json` with the
  same migration discipline as the rest of the schema.
- Keep GSD as **one importer** among others, not the source of truth.
- Let a task be created from the UI, from an agent via the existing `TaskCreated` hook, or from an
  imported plan.
- Expose the DAG that `run_scheduler_tick` already resolves — dependencies and blocking are computed
  today and shown nowhere.

**Why first:** every later phase needs a task it can point at.

## Phase 2 — Delegation

Make "run this task on that agent, in its own worktree" a single action.

- Bind a task to a worktree at dispatch, using `worktree_path` — the field already exists on `Task`.
- Dispatch to an agent by capability rather than by name: the MCP and Skills inventory from 1.6.0
  already knows which agent has which tools.
- Use `lease_resource` to enforce mutual exclusion on shared resources (a migration file, a lockfile,
  a port) so two agents cannot collide.
- Consume `TeammateIdle` to pull the next `Ready` task instead of leaving agents idle.
- Reuse the 1.6.0 handoff packet as the delegation payload — it already redacts secrets and clips to
  a size budget, which is exactly what a task briefing needs.

**Open question:** whether a delegated agent runs in a visible pane or headless. Headless is cheaper
and scales, but it breaks Alethe's core promise that you can always see and take over any agent.
Leaning toward visible-by-default with an explicit background mode.

## Phase 3 — Supervision

Today you can see one agent. You cannot see a run.

- A run view: every task in the DAG with its status, its agent, its worktree, its elapsed time and
  its cost — `agent_cost.rs` already tracks the last part per agent.
- Surface `Blocked` prominently. A blocked task is the most actionable state in the system and is
  currently invisible.
- Stream `PreToolUse` / `PostToolUse` into a per-task activity trail, so a stalled agent is
  distinguishable from a slow one.
- Hard limits: max concurrent agents, max spend per run, wall-clock timeout per task. None of these
  exist today, and unattended orchestration is unsafe without them.

## Phase 4 — Landing

The stage that 1.6.0 removed.

- Bring the Merge Center back as the terminal stage of a run rather than a standalone panel: a task
  in `Completed` has a worktree with commits, and landing is what closes it.
- Validate before landing, not after — the removed implementation already ran project validation
  commands and dedicated reviewer agents; that behavior is worth restoring.
- Land in dependency order, so a task never merges ahead of what it depends on.
- Existing work to build on: PR #108 added GitHub PR discovery and guarded squash merge against the
  removed panel. It is early work against a subsystem that is coming back, not dead code.

## Phase 5 — Policy

Only once the four stages above are real.

- Agent selection by capability, cost and current load rather than round-robin.
- Retry and escalation: a task that fails twice on one agent moves to another, carrying its context
  through the handoff packet.
- Budgets per project, not just per run.

---

## Explicit non-goals

- **No hosted orchestration.** Everything stays local-first. Cloud sync and hosted services remain
  separate from the local app, as stated in `OVERVIEW.md`.
- **No agent autonomy without a visible trail.** Every delegated action must be attributable to a
  task and inspectable after the fact.
- **No lock-in to one agent vendor.** Orchestration must work across Claude Code, Codex, OpenCode,
  Copilot CLI and Antigravity, or it is not worth building.

---

## Risks

- **The scheduler is unproven at scale.** It resolves dependencies and leases correctly for the small
  GSD graphs it sees today; nothing has stressed it.
- **Worktrees are cheap on Linux and expensive on Windows.** Provisioning per task may need pooling.
- **Cost visibility lags reality.** Usage data is polled per agent, so a run's spend is an estimate
  until the run ends.
- **Landing is the hardest stage and the one with the least code today**, since the previous
  implementation was removed rather than refactored.

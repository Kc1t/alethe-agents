---
name: alethe
description: Orchestrate bounded Codex, Claude Code, Agy, Kimi, or custom CLI workers to finish work with the least lead context and provider usage, following playbooks such as plan big, execute small. Use when the user asks to orchestrate, delegate, compare agents, conserve agent tokens or quota, recover a worker, report what an orchestration did and cost, or work without MCP or Python, when the user types /alethe or a short command such as "alethe report" or "alethe stop", and when they want it on from now on, at any point of a task and alongside other skills. Also use it proactively, without being asked, when a request is large enough to split into bounded independent units, such as a multi-file refactor, a migration, an audit or research across many files. Do not use for a small mechanical task unless explicitly requested.
argument-hint: "[task or standing instruction] | on | off | save | max | freestyle | careful | report | status | usage | models | editor | list | stop | skip <phase> | switch <playbook> | freeform | budget <limit> | mark <worker> <used|partial|discarded> | setup | help"
metadata:
  version: "21"
---

# Orchestrate CLI workers

Finish the work with the least lead context and the cheapest capable workers, or the strongest
mix when the user asks. Plan, delegate bounded units, and integrate results supported by evidence.

- **Playbook** = the phases and roles.
- **Profile** = which models each tier uses (`base`, `savings`, `aggressive`).
- **Goal** = how eagerly to delegate while a mode is on (`save`, `balanced`, `max`, `freestyle`).
- **Runner strategy** = how one wave runs (`economy`, `balanced`, `quality`, `research`, `parallel`, `rescue`).

## Choose the backend

Honor an explicit request for the local skill or no MCP. It always wins. Otherwise run
`scripts/orchestrate.py policy show` and use its `backend`: `skill` selects this runner, `mcp`
selects `alethe_*` tools when present, and `auto` prefers those tools when available.

Python is optional. If `python --version`, `python3 --version` and `py --version` all fail or report
below 3.9, or the user asks, follow [references/manual.md](references/manual.md) for detection,
options, background workers and reporting. All other sections still apply through manual equivalents.

The skill path needs no MCP. It runs bounded concurrent workers with optional worktree isolation
and resumable sessions. CLI workers do not appear on Alethe's board.

## First run and configuration

Run `scripts/orchestrate.py doctor` when the environment may be unprepared or the user asks what
is set up. It checks Python, providers, the saved policy and the user's playbooks copy, and
summarizes quota readings with actionable hints.

When `doctor` reports no configured policy, or the user asks to set up orchestration, follow
[references/onboarding.md](references/onboarding.md): inventory the CLIs, models and routes, build
profiles `base`, `savings` and `aggressive`, and get approval before saving them to the playbooks
copy. Save only confirmed preferences. A proxy such as 9router carries model traffic; it is not a worker.

Setup never blocks work. Mid-task with nothing configured, run `doctor`, use its logged-in CLIs
with the bundled playbooks, say so in one line and continue. Offer onboarding after the current
step; save nothing until the user agrees.

Translate loose configuration requests into actions:

| The user says | Do |
| --- | --- |
| "save provider X" as an ongoing preference | confirm, then `policy set --conserve-providers X` |
| "use cheap models for the small stuff" | confirm the provider and model, then edit `tiers` in the playbooks copy |
| "at most N workers / T minutes / C dollars" as an ongoing preference | confirm, then `policy set --max-calls N --max-wall-seconds T --max-reported-cost-usd C` |
| any of the above "for this run only" | put it in the plan's `budget` or use `--strategy`; never touch the policy |
| "at most N calls / C dollars / T tokens for this whole task" | `budget` with those limits before the first wave |
| "where were we", or after the conversation was compacted | `status` before anything else |
| "back to defaults" | confirm, then `policy reset` |
| "change the playbooks" or roles per phase | `playbook --init`, then edit the copy it prints; the UI exports the same file |
| "use savings" or "go aggressive" as an ongoing preference | confirm, then set `profile` in the playbooks copy |
| "what did it do", "how much did it cost" | `report`; no confirmation needed |

## Short commands

`/alethe <args>` in Claude Code, or the same words after "alethe" anywhere else, map to one
action. Run-specific commands without a folder use the current orchestration: the one `new` started,
`use` picked, or the last `run` wrote to.

| Words | Do |
| --- | --- |
| a task, in plain words | orchestrate it as the rest of this skill describes |
| nothing | `status`; with no current orchestration, list these commands in a few lines |
| `on`, or a standing instruction ("from now on...") | stay on, as below |
| `always`, or "always on", "in every project" | `mode on --everywhere` |
| `off` | `mode off`; with the default on, this turns it off in this project only |
| `off everywhere` | `mode off --everywhere` |
| `save`, `balanced`, `max`, `freestyle` | `mode on --goal <it>` |
| `careful` | `mode on --care careful` |
| `report [folder]` | `report`, and show its output as is, without a summary of your own |
| `report html`, or "show the report" | `report --format html`, which writes `report.html` in the folder and opens it; without Python, fill `assets/report.html` as in [references/manual.md](references/manual.md) |
| `status` | `status`, and show its output as is |
| `usage` | `usage`, or `usage --refresh-claude` when Claude's reading is missing or stale; show windows, resets and freshness |
| `models` | `models`; show model prices, ranks and price freshness |
| `editor`, or "show the playbooks" | `editor`, which writes the playbooks as a flow page and opens it; without Python, fill `assets/editor.html` as in [references/manual.md](references/manual.md) |
| `list` | `list`; `use <folder>` makes one of them current again |
| `stop` | `stop`, then `status` once the waves have ended |
| `budget <limit>` | `budget --max-calls N`, `--max-reported-cost-usd C` or `--max-reported-tokens T` |
| `skip <phase>`, `switch <playbook>`, `freeform`, `add <phase>` | change course as below |
| `note <text>` | `note "<text>"` |
| `mark <worker> used\|partial\|discarded` | `mark <worker> <mark>` |
| `setup` | `doctor`, then onboarding when no policy is saved |
| `help` | list these commands in a few lines |

## Stay on

1. Use it proactively whenever a request splits into bounded independent units, even when nobody
   mentions orchestration, as the description says. Small or tightly coupled work stays with you.
2. `mode on --everywhere` makes it the default in every project, with no expiry. `mode off` in a
   project turns it off there only, and `mode off --everywhere` removes the default.
3. `mode on` keeps it on for the current project (the repository root, or the folder) until
   `mode off`, or after 12 hours without a prompt. A project mode wins over the default.

Both modes take the same options:

- `--goal save` spends as little as possible, `max` gets the most out of the available agents, and
  `balanced` (the default) delegates only when the playbook says it pays.
- `--goal freestyle` drops playbooks, plans and waves: you work as usual and only watch over cost.
  Check quota before long or heavy steps. When a cheaper or better route exists, say so in one
  line, at most once per reply and not again once declined: "This rename is mechanical, so I'll
  hand it to a Sonnet worker to keep it cheap." Take a cheaper route that keeps the quality the
  step needs and say so in that line; ask before anything that costs more, starts several workers
  or passes the quota stop line. Your own model is the user's to change: suggest `/model <name>`.
  It is not `freeform`, which drops the playbook of a running orchestration.
- `--care careful` reads before writing, isolates every writer, reviews every diff before
  integrating it, and asks before anything hard to undo.
- `--rule "<the user's words>"` keeps a standing instruction, up to 8; `--clear-rules` drops them.

Turn it on when the user says `/alethe on`, gives a standing instruction, or asks for orchestration
"from now on". Map the instruction to a goal or care level when one fits, and keep the user's own
words as a rule. Confirm in one line what is now on, then go back to what they were doing.

The Claude Code hook reminds you while a mode is on; without it, run `mode show` at session start
and after compaction. Delegate only where the overhead pays under the goal; keep small work yourself.

## Join mid-task

Join at any point, including inside another skill's workflow. Do not start over:

1. Take what already exists as the plan: the conversation, a spec, a task list, a design doc, the
   diff so far. Point workers at those files instead of copying them.
2. Keep the other workflow's steps and gates: pending tasks become units and its checks become
   gates. Rewrite its files only when one of its steps says to.
3. Use `new` only for delegated work. Keep small, coupled or ambiguous work with the lead; say why
   in one line.

## Pick a playbook, then adapt

Before planning, run `scripts/orchestrate.py playbook --pick` for the active profile, provider
order, pick conditions and playbook summaries. Then run `playbook <id>` for the chosen playbook,
resolved tiers and quota and budget rules. Both accept `--json`; plain `playbook` prints the whole
file for editing or onboarding only. See [references/playbooks.md](references/playbooks.md).

1. Pick a playbook with `pickOrder`. A playbook the user names wins; so does a runner strategy
   name, which keeps the single-wave behavior described below. `complete` adapts per unit when
   nothing else fits.
2. Run the phases in order. `who: lead` is you, in this session. Every other phase is one wave of
   workers: its `runner` is the plan `strategy`, `workers` the unit count, `readOnly` means
   `mode: read-only`, and `isolate` gives each writer its own worktree.
3. Skip a phase whose `if` does not hold; among paths joined by `with`, the first true one runs.
   Check a phase's `gate` yourself; on fail, run its `after` chain once per unit, then check again.
4. Resolve each worker's tier through the playbooks file and active profile, then apply the first
   matching rule. Deprecated `policy.modelTiers` overrides still win when set; save new tiers only
   in playbooks. Pass model and effort explicitly; keep read-only work on a capable provider.
5. Say which playbook you picked and why in one line before the first wave.

## Watch the quota

Never let a provider run out, under every goal, profile and runner strategy, asked or not. Before
every wave:

1. Run `scripts/orchestrate.py usage`. Codex readings come from its session files, Claude readings
   from each Claude worker's `rate_limit_event`. When the plan or you use Claude and its reading is
   missing or stale (>30 minutes), run `usage --refresh-claude`, a one-line Haiku call.
2. Read `quotaForecast` in `dry-run`: what the wave may take of each window, learned from past
   waves. With too few samples it is unknown; say so instead of guessing.
3. If a provider is low (at or above `quota.criticalThreshold`) and the next provider in the order
   runs the same tier, move the work and tell the user in one line with the numbers and reset
   time: "Moving the scouts to Codex: your Claude is at 86% of its 5-hour window (resets 14:30),
   Codex is at 33%." Spend quota that would be lost per `quota.whenSpare`.
4. Stop and ask before launching when the only way around a low provider lowers the tier the work
   needs, every provider is low, or the forecast passes `quota.stopAt`. Say what the work needs,
   what is left and when it resets, then offer two to four options with a recommendation, using
   the agent's question tool when it has one:
   - wait for the reset;
   - run it on another provider, saying what changes;
   - a cheaper tier only for the units that allow it, saying the risk;
   - run now only the units that fit;
   - connect another CLI or account (`setup`);
   - go on anyway, only on the user's word, with `run --allow-low-quota`.

   "This migration needs the strong tier (Opus). Your Claude is at 91% of its 5-hour window and
   resets at 14:30, in 2h10; this wave may take about 15%. 1) wait until 14:30 (recommended),
   2) Codex high now, at 40%, 3) Sonnet for the two mechanical units only, 4) connect another CLI."
5. `run` refuses a wave, and skips queued workers (`failureKind: quota_low`), on a provider at or
   past `quota.stopAt`. A worker that hit a limit fails as `rate_limited`. Handle both as step 4.

The user's pinned provider, and their answer, win over these rules. When you run on a low provider
yourself, say so, keep your own turns short and hand work to a provider with room. If a reading is
stale, say so instead of asserting its number. Record every change with
`note "<reason and readings>" --kind switch`. See the reference for unknown readings.

## Change course

Between waves, adapt the plan to results or the user's request: skip, repeat or add phases, do a
step yourself, change providers, models or budget, switch playbooks, or plan freeform waves.
The user's request wins over the playbook.

Record each change in one line before the next wave, so the report can explain it:

| Change | Command |
| --- | --- |
| skip a phase | `note "<phase>: <why>" --kind skip` |
| add a phase or a worker | `note "<what>: <why>" --kind add` |
| switch playbook, or go freeform | `note "to <playbook or freeform>: <why>" --kind switch` |
| do a step yourself | `note "<what you did>" --kind lead` |
| anything else | `note "<what changed and why>"` |

A freeform wave is an ordinary plan: leave `playbook` out and name the `phase` after what the wave
does. Stop a wave that is no longer useful with `stop`; workers that already ran keep their results.

## Orchestrate

1. Delegate when the overhead pays; runner strategies `economy` and `rescue` allow one worker.
2. Read [references/routing.md](references/routing.md) for the runner strategies each wave can use:
   `auto`, `economy`, `balanced`, `quality`, `research`, `parallel`, or `rescue`. An explicit
   runner strategy in the current request wins over saved preferences. Treat the word after an
   explicit skill invocation as the playbook or runner strategy when it matches a name.
3. Run `scripts/orchestrate.py probe` and use only available providers. Read
   [references/providers.md](references/providers.md) when using Agy, Kimi, resuming a worker, or
   adding a custom CLI.
4. Give writers disjoint ownership. Use an isolated worktree for concurrent writers; a single
   writer may use the main checkout when existing user changes are preserved.
5. Create a version-1 plan JSON outside the repository. `scripts/orchestrate.py scaffold
   <strategy> --workers N` prints a valid skeleton to fill in. Use `strategy`, and use
   `provider: auto` only when saved provider switching preferences may decide the provider. Set
   the plan's `budget` when one wave needs hard limits, and run `budget` when a limit covers every
   wave of the orchestration.
   Give the plan a `title`, the `playbook` and `phase` it runs, and a one-line `why`; give each
   worker a short `why` naming its role and the reason for its model. The report shows them.
   Write each task as [references/briefs.md](references/briefs.md) describes. Codex and Claude
   workers start without MCP servers; set `mcp: true` only for a brief that needs one. Validate
   the plan against [schemas/plan.schema.json](schemas/plan.schema.json) or with
   `scripts/orchestrate.py validate`.
6. Run `models`. For a needed missing or stale price (>60 days), look it up only on the vendor's
   official pricing page, tell the user, and save the entry with `source` and `asOf` in
   `alethe-prices.json` next to the policy; never guess. See [references/operations.md](references/operations.md).
   Preview with `dry-run`: runner strategy, providers, concurrency, prompt tokens, budget and
   `listPriceEstimateUsd` (an estimate) and `quotaForecast`. Fix warnings, including default
   models, low providers and the stop line, or explain why they do not apply.
   When the user wants to see the architecture, save the preview with `dry-run --write`, then
   render it with `scripts/diagram.py` as described in [references/diagram.md](references/diagram.md).
   Show the SVG before running workers and use only confirmed proxy routes.
7. Start the orchestration once with `scripts/orchestrate.py new "<title>" --playbook <name>
   --why "<one line>" --lead <your CLI>:<your model>`, such as `--lead claude:opus`; it creates the
   folder, makes it current and names you as the lead in the report. Start every wave with
   `run <plan> --in current --detach`, then call `wait [--timeout N]` (at most 540 seconds) until
   `done` is true; it returns status too. Claude Code may instead use the shell tool's background
   mode. Never run a wave in the foreground of a shell tool with a short timeout. Interrupted
   runners are detected; `stop` also kills leftover workers. The runner caps concurrency and budgets
   and leaves worktrees for review. It uses argument arrays; an unreadable `.cmd` shim runs through
   `cmd.exe` only under the argument restrictions in [references/providers.md](references/providers.md).
8. Read `state.json`, each `outcome.json` (its `workerStatus`, `failureKind` and
   `readOnlyViolation` first), the concise `result.md`, and writer `diff.patch` files. Do not load
   raw logs unless diagnosing a failure.
9. Integrate reviewed changes, run validation in the combined checkout, `mark` each worker's result
   `used`, `partial` or `discarded`, then remove only temporary data and worktrees whose useful
   changes were handled. `mark <worker> used` finds the worker in the current orchestration.
10. Close with `scripts/orchestrate.py report` and show its output: work, reasons, changes, reported
    spend and what remains. Use it for user cost questions; no folder means the current orchestration.

For plan examples, result semantics, selective dirty-state seeding, and cleanup, read
[references/operations.md](references/operations.md).

## Worker contract

Each brief must state the task goal, definition of done, owned paths, relevant repository rules, checks,
forbidden changes, and desired handoff. The runner automatically appends these invariants:

- do not delegate, spawn subagents, or launch another agent CLI
- do not commit, push, tag, release, or open a pull request
- return a concise outcome, evidence, changed files, checks, failures, and risks
- finish with a `STATUS:` line (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`) and a
  `SUMMARY:` line

Codex and Claude workers cannot start subagents: the runner turns that off in the CLI. Every
worker runs with `ALETHE_ORCHESTRATE_WORKER=1`, so it cannot start an orchestration of its own. A
worker's status and summary are claims; check its diff. For review, validation, judge and panel
briefs, follow [references/briefs.md](references/briefs.md).

Do not put secrets in plans, tasks, arguments, or logs. Do not use bypass flags unless the user
explicitly requested that loss of isolation; custom workers require `allowUnsafe: true` for known
unsafe flags.

## Token discipline

- Treat statements such as "low on tokens", "save quota", or "economize" as runner strategy `economy` for the
  current run. Persist it with `policy set economy` only when the user asks for an ongoing default.
- A plan `budget` turns saving into a hard limit: cap worker calls, wall time, estimated prompt
  tokens, reported tokens and reported cost. Use `dry-run` to see the estimate before anything
  runs. Only Claude reports cost, so `maxReportedTokens` caps the others. Cache reads are reported
  separately and excluded from `maxReportedTokens` and the report's Value token split.
- More workers increase total provider usage. `auto` must choose no orchestration when the task is
  cheaper to finish directly; if orchestration was explicitly requested, it chooses the smallest
  valid runner strategy.
- Point to files rather than copying them; read concise results and diffs, not transcripts.
- Reuse `sessionId` only for focused follow-ups. Use cheap workers for bounded discovery and
  mechanical work; keep ambiguity and integration with the lead or a capable reviewer.
- A failed worker may be retried once only when the error has a specific correctable cause.

Do not commit, push, tag, release, or open a pull request unless the user explicitly asked for it.

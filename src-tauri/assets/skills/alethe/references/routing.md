# Routing and token policy

Read this reference when deciding whether to delegate, choosing a runner strategy, or assigning providers.

## Delegate only useful independence

Delegate when at least two units can make progress without reading each other's unfinished output.
Good boundaries are a service, package, feature area, independent investigation, or review of an
already-produced diff.

Keep the work with the lead when it is a one-command operation, a uniform batch transformation, a
small local edit, or a chain where every step depends on the previous one.

## Runner strategies

| Runner strategy | Workers | Concurrency | Use |
|---|---:|---:|---|
| `auto` | inferred | inferred | Choose the smallest runner strategy that fits the plan |
| `economy` | 1 | 1 | One concise offload with minimum provider usage |
| `balanced` | up to 4 | 2 | Default independent implementation or investigation |
| `quality` | 1 per wave | 1 | Writer, reviewer, and repair in separate sequential runs |
| `research` | up to 8 | 4 | Read-only comparisons with evidence-based handoffs |
| `parallel` | up to 8 | 4 | Disjoint implementation; every writer is isolated |
| `rescue` | 1 | 1 | Resume one interrupted or failed provider session |

The runner enforces these limits rather than relying on the worker prompt. A plan can lower
concurrency but cannot raise a runner strategy or saved-policy cap. `performance` remains
accepted as a legacy alias for `parallel`.

`auto` infers `rescue` for one resumed worker, `economy` for one new worker, `research` for an
all-read-only batch, `parallel` for two or more isolated writers, and `balanced` otherwise. It does
not infer `quality`, because the extra review cost should be explicitly requested.

## Saved skill-only policy

The runner owns a portable preference file; it does not need Alethe or MCP. Inspect it before
planning:

```text
python scripts/orchestrate.py policy show
```

Examples:

```text
python scripts/orchestrate.py policy set economy
python scripts/orchestrate.py policy set --backend skill --provider-switch automatic
python scripts/orchestrate.py policy set --provider-order codex kimi agy claude
python scripts/orchestrate.py policy set --conserve-providers claude --max-workers 1
python scripts/orchestrate.py policy reset
```

Set `ALETHE_ORCHESTRATE_POLICY` or pass `--policy <file>` to use a specific policy. The default is
under `%APPDATA%\Alethe\` on Windows and the user's XDG config directory on Unix-like systems.

`backend` is a routing preference for the skill: `skill` always uses the local runner, `mcp` uses
the Alethe tools when they exist, and `auto` prefers MCP but falls back locally. An explicit user
request always wins.

`providerSwitch` controls a provider marked in `conserveProviders`: `never` keeps it, `ask` stops
validation with a clear choice, and `automatic` selects the first installed alternative in
`providerOrder`. Automatic switching is refused when a worker pins a provider-specific model,
effort, or resumed session.

`budget` holds default execution limits with the same fields a plan accepts: `maxCalls`,
`maxWallSeconds`, `maxEstimatedPromptTokens`, `maxReportedTokens`, and `maxReportedCostUsd`.
A plan overrides them field by field. When Alethe is installed, its Orchestration preferences own
the backend, default runner strategy, provider switching, conserved provider and concurrency, and
put the preferred provider first in the saved order; `budget`, legacy `modelTiers` overrides and
the rest of the order stay as `policy set` left them.

```text
python scripts/orchestrate.py policy set --max-calls 4 --max-wall-seconds 1800
```

## Model tiers

All three tiers resolve from `tiers` in the effective playbooks file plus the active profile's
overrides. `playbook <id>` shows the resolved model and effort for each provider and tier.
Deprecated `policy.modelTiers` entries still win when set, including values saved by
`policy set --cheap-model`; put new tier choices only in the playbooks copy.

A worker declares `tier: cheap`, `standard` (the default), or `strong` instead of naming a model.
Because the tier resolves after the provider is chosen, it composes with `provider: auto`. An
explicit `model` or `effort` pins provider-specific semantics. A worker cannot combine a
non-standard tier with an explicit model or effort. If the resolved tier leaves the model empty,
the CLI uses its default; `validate` and `dry-run` warn even when an effort is present.

Runner strategy `economy` defaults its single worker to `tier: cheap` when the plan pins neither
a tier nor a model. Tiers also cut cost with one provider, where provider switching cannot help.
Check prices and relative ranks with `models`; missing or stale (>60 days) needed prices must be
verified on the vendor's official pricing page and saved with `source` and `asOf` in
`alethe-prices.json`. See [operations.md](operations.md) for billing and estimate rules.

Model names change over time and the runner does not verify them; a misspelled model is a worker
failure, surfaced in `outcome.json`.

## Route by requirements

Use this order:

1. Honor a provider or model explicitly requested by the user unless the user also enabled
   automatic switching for that provider.
2. Identify required capabilities: read-only, writing, structured output, resume, or a specific
   tool ecosystem.
3. Exclude unavailable providers and providers without the required capability.
4. Prefer configured cheap models for bounded reading and mechanical work.
5. Keep architectural or ambiguous work with the lead or a stronger configured model.
6. When quality needs an independent view, review with a different provider or model after the
   implementation exists.

Before every wave, run `usage` for Claude worker-event readings and fresh Codex session-file
readings. Move an unpinned low-provider plan to the next capable provider in the active order at
the same tier, resolving its model and effort again; apply `quota.whenSpare` when quota would be
lost. This applies under every goal, profile and runner strategy. User provider pins and hard
budgets still hold. Never lower a tier to dodge a low provider, and never run into
`quota.stopAt`: ask the user, with the options in the skill's "Watch the quota" section. Report at most one quota line per wave, disclose stale readings, and record
changes with `note "<reason and readings>" --kind switch`. See [playbooks.md](playbooks.md) for
conditions that still need Alethe or the user. Never infer available quota from a CLI's presence.

## Keep handoffs small

Ask a research worker for findings with file/line or source evidence, not a narrative transcript.
Ask a writer for changed paths, checks, failures, and risks. The lead should read the worker's diff
instead of asking it to paste code into its answer.

Use a returned `sessionId` only for a related follow-up. Start a fresh session for unrelated work
so stale context does not increase cost or bias the answer.

## Waves

- Parallel wave: independent readers or writers with disjoint files.
- Integration wave: the lead reviews and combines results.
- Review wave: a separate worker reviews the integrated diff.
- Repair wave: at most one focused retry or follow-up for a demonstrated issue.

Start every wave with `run <plan> --in current --detach` and call `wait [--timeout N]` (at most
540 seconds per call) until `done` is true. Claude Code may use the shell tool's background mode
instead. Never run a wave in the foreground of a shell tool with a short timeout. Do not run a
reviewer in parallel with the code it must review.

# Playbook file reference

Run `scripts/orchestrate.py playbook --pick` before planning. It prints the active profile and
provider order, one line per `pickOrder` entry, and each playbook's id, name and `pickWhen`.
Then `playbook <id>` prints only that playbook, the resolved active tiers (provider and tier to
model/effort), provider order, quota and budget rules. Both accept `--json`.

Plain `playbook` prints the whole effective file for editing and onboarding only. The user's copy
replaces the bundled file. `playbook --init` copies it next to the saved policy; delete the copy
to restore defaults. `doctor` validates the copy. See [onboarding.md](onboarding.md) for setup.

## See and edit the playbooks

`editor` writes the effective playbooks as a flow page, `alethe-playbooks.html` next to the policy
(or `--out <file>`), and opens it (`--no-open` only writes it). Each playbook is a flowchart with
its conditions, fallbacks and the model each step resolves to under the chosen profile. The page
starts from the latest quota readings as the `now` usage preset; the other presets and sliders
only simulate. Task, checks and budget switches show which branch runs. Edits stay in the page
until the user copies or downloads the YAML; save it over the user's copy and run `doctor` before
the next plan. The page is one offline file and reads the YAML itself, so it needs no Python: see
[manual.md](manual.md). It shows the playbooks; to show one plan's workers, use
[diagram.md](diagram.md).

## Top level

| Field | Meaning |
|---|---|
| `setup` | Written by onboarding: the `date` the user approved the profiles and `notes` on what was found or skipped |
| `principles` | Saving rules that apply to every plan |
| `providers` | The CLIs the user approved, in the base order of preference |
| `models` | Model ids each CLI listed, optionally as `{ id, cost }` with the CLI's cost multiplier |
| `adapters` | A checked custom adapter for each provider without a built-in one |
| `routes` | Gateways on the model traffic path, such as `router9` |
| `tiers` | What `cheap`, `standard` and `strong` mean per provider: a model and an effort |
| `quota.criticalThreshold` | Percent of any main usage window that counts as low on tokens |
| `quota.stopAt` | Percent at which `run` refuses a wave and skips queued workers on that provider; at least `criticalThreshold`, 95 by default |
| `quota.whenLow` | `switch-provider` runs a role on the next provider in the order at the same tier; `keep` stays |
| `quota.onBothCritical` | `ask`, `run-cheapest` or `block` when every provider in the order is low |
| `quota.whenSpare` | What to do with a provider's spare quota: `spend-strong` runs workers on its strong tier, `prefer` runs them on it at their own tier, `ignore` changes nothing |
| `quota.spareWithinHours` | A weekly or monthly cycle that resets within this many hours counts as spare |
| `quota.spareMinLeft` | Percent of that cycle that must be left for it to count as spare |
| `quota.planEnds` | Dates a plan ends without renewing, by provider, for example `{ codex: "2026-10-20" }` |
| `budget.warnAt` | Percent of the plan budget that counts as low |
| `budget.whenLow` | `finish-and-report`, `downgrade-tier` or `stop` |
| `profile` | The active profile |
| `profiles` | Named sets of overrides, usually `base`, `savings` and `aggressive` |
| `pickOrder` | Which playbook to pick for which kind of task, checked top to bottom |
| `playbooks` | The playbooks, by id |
| `routing` | Optional; maps one delegation's kind and effort to a role, exported by the UI |

## Providers

`claude`, `codex`, `agy` and `kimi` have built-in adapters. Any other CLI, such as `kiro`,
`copilot` or `gemini`, runs as a `custom` worker built from its entry in `adapters`:

| Field | Meaning |
|---|---|
| `command`, `args` | The executable and the arguments before the prompt |
| `promptTransport`, `outputFormat` | As in a custom worker: `stdin` or `argument`; `text`, `json` or `jsonl` |
| `modelFlag`, `effortFlag` | The flags that take a model id and an effort, when the CLI has them |
| `checked` | The help command that confirmed the invocation, and when |

A custom adapter cannot enforce read-only work, so `auto` never sends it a `readOnly` phase. Add
the tier's model and effort through its flags when building the worker.

A route carries a CLI's API traffic; it is not a worker. `routes.router9` records the `port`,
whether it is `running`, and which CLIs it `carries`: only `claude` and `codex` speak its dialects.
Model names for a carried CLI go to whatever the gateway maps them to. Never start, install or
reconfigure a route; Alethe does that.

## Profiles

The active profile changes three things and leaves the playbooks alone:

| Field | Effect |
|---|---|
| `order` | Replaces the order of `providers`; providers it leaves out are tried last |
| `quota` | Overrides those `quota` fields |
| `tiers` | Overrides the model and effort of the tier and provider entries it names |

`base` usually has no overrides. Switch profiles by changing `profile`, after confirming when it is
an ongoing change rather than one run. All three tiers (`cheap`, `standard`, `strong`) resolve from
`tiers` plus the active profile's overrides. Deprecated `policy.modelTiers` overrides still win
when set; `policy set --cheap-model` is a legacy path, not where onboarding writes new tiers.

## Phases

A playbook lists `phases`. Each phase is one role:

| Field | Meaning |
|---|---|
| `id` | Unique within the playbook |
| `role` | The name used in briefs and shown to the user |
| `who` | `lead` is you, in this session; anything else is a worker wave |
| `tier` | `cheap`, `standard` or `strong`, resolved through the active tiers |
| `provider` | `auto` (default) takes the first provider in the active order that can run the phase; a provider id pins it |
| `model`, `effort` | Override the tier for this phase |
| `readOnly` | Run workers with `mode: read-only` |
| `workers` | Units in the wave, within the runner's limit |
| `isolate` | Give each writer its own worktree |
| `runner` | The plan's runner strategy (`strategy`) for the wave: `economy`, `balanced`, `quality`, `research`, `parallel` or `rescue` |
| `does`, `returns`, `limit` | What to put in each brief and what to ask back |
| `gate` | What you check after the phase before moving on |
| `if` | The phase runs only when the condition holds |
| `with` | Joins that phase's step. When any path in the step has `if`, the paths are alternatives and the first whose `if` holds runs; when none has `if`, they all run in the same wave |
| `after` | Runs only after the `gate` of that phase fails, or after that escalation phase |
| `then` | `next` (default), `recheck` (check the gate again) or `done` (stop here) |
| `rules` | Model choices for this role, checked top to bottom: `if` a condition, `use` a tier, provider, model or effort |

## Choosing the model

For each worker:

1. Start from the phase's tier and provider, with the active profile's tiers and order.
2. Apply the first rule whose `if` holds. Skip a rule whose model belongs to a different provider
   unless it also names that provider. A rule can steer a phase off expensive models with
   `price-above` and cap a run's later waves with `spent-above`, for example
   `if: price-above:5` → `use: { tier: cheap }`.
3. Before every wave run `usage`. If the chosen provider is low, move to the next capable provider
   in the active order at the same tier, resolving that provider's model and effort. Respect a
   provider the user pinned; a playbook's suggested provider does not prevent adapting the plan.
   Never lower a tier to dodge a low provider; ask the user instead.
4. If every provider is low, follow `quota.onBothCritical`. If the `dry-run` forecast passes
   `quota.stopAt`, ask the user whatever `onBothCritical` says.
5. Apply `quota.whenSpare` when unused quota would be lost, under every goal, profile and runner
   strategy. Goal `save` is not required. Keep budget limits and user provider pins; when
   several providers have spare quota, prefer the one that loses it first.

Change the plan before launching; these are lead decisions, not automatic live quota routing by
the runner. The runner only enforces `quota.stopAt`: it refuses a wave on a provider at or past it
and skips queued workers once a running wave crosses it, unless the user agreed to
`run --allow-low-quota`. Tell the user at most one quota line per wave with the readings and reset time, and
record it with `note "<reason and readings>" --kind switch`. Say when a reading is stale rather
than asserting its number. `quota.whenLow: keep` remains a file setting; the skill's pre-wave
check still calls for adapting an unpinned low-provider plan.

Pass the resolved model and effort explicitly. If a model remains empty, the CLI uses its default;
both `validate` and `dry-run` warn even when an effort is set.

## Usage windows

| Provider | Main windows | Cycle used for spare quota |
|---|---|---|
| `claude` | `5h`, `week` (plus `opus`) | week |
| `codex` | `5h`, `week` | week |
| `agy` | `gemini`, `claude` (plus `gpt`) | none |
| `kimi` | `5h`, `week` (plus `month`) | week |
| `kiro` | `credits` | monthly credits |
| `copilot` | `premium` | monthly premium requests |
| `gemini` | `day` | none |

`usage` reads Claude quota from each Claude worker's `rate_limit_event`, as fresh as the last
Claude worker, and Codex quota from its own session files, freshly read without starting a worker.
`usage --refresh-claude` reads Claude now with a one-line Haiku call. None needs Alethe. Readings
are cached in `alethe-usage.json` next to the policy; `status` and `doctor` show summaries, and
`dry-run` warns for each worker on a low provider.

Each provider/window reports `usedPercent`, `resetsAt`, `ageMinutes`, `low` (at or above
`quota.criticalThreshold`), `blocked` (at or above `quota.stopAt`), `stale` (>30 minutes), and
`reset`. Use the active profile's thresholds. Within a window usage only grows, so a stale reading
still blocks until its `resetsAt` passes. Claude's `opus` window blocks only Opus workers.

After each wave the runner records what each worker took of each window it can compare, in the
same window before and after, as a sample in `alethe-usage.json` (the last 40 are kept). Samples
include anything else that used the account during the wave, so they overstate rather than
understate. `dry-run` turns the recent ones into `quotaForecast`: the median per worker of the same
model, or of the provider when the model has fewer than two, summed over the wave's workers. Fewer
than two samples leave it unknown.
Antigravity and Kimi readings still need Alethe or the user; other providers need the user.
Missing or stale data is unknown, not evidence of spare quota or available capacity.

## Spare quota

A provider's quota is spare when it is not low, at least `spareMinLeft` percent of its cycle is
left, and that quota would be lost: its plan ends before the cycle resets, or the cycle resets
within `spareWithinHours`. A plan that ends in 2 days while the week resets in 6 loses everything
left. For subscription billing, spending that quota does not add an API charge; API billing still
incurs the model's price. See [operations.md](operations.md) for billing and price rules.

## Conditions

`if` takes one condition or a list; a list holds when all of them hold. Prefix one with `not ` to
negate it. `<provider>` is any provider id and `<window>` one of its windows above.

| Condition | Holds when |
|---|---|
| `narrow` | The task is small and clear, up to about 3 files |
| `risky` | The unit changes an API contract, a database schema or migration, authentication, cryptography or secrets, or deletes data. Judge it by the operation, not by a word such as "auth" in the brief |
| `kind:<kind>` | The unit's kind is `research`, `code`, `review`, `command`, `scrap` or `docs` |
| `light`, `standard`, `deep` | The unit's effort class |
| `<provider>-low` | A fresh `usage` main window is at or above `criticalThreshold`, it is listed in `conserveProviders`, or Alethe or the user reports it low |
| `all-low` | Every provider in the order is low; `both-low` means the same |
| `<provider>-above:<n>` | The busiest main window in a fresh reading is past n percent |
| `<provider>-<window>-above:<n>` | That window in a fresh reading is past n percent, for example `claude-opus-above:50` or `codex-week-above:80` |
| `<provider>-spare` | That provider has spare quota |
| `budget-low` | More than `budget.warnAt` percent of the plan budget is spent |
| `price-above:<usd>` | The model the unit would run on, from the phase's tier, provider and model before this rule, lists an input price above `<usd>` US dollars per 1M tokens in the price table, for example `price-above:5` or `price-above:2.5`. A model with no known price, including the CLI's default when none is pinned, cannot establish it |
| `spent-above:<usd>` | This orchestration's reported spend so far, as `status` and `report` total it, is above `<usd>` US dollars. Only cost the CLIs reported counts; nothing is estimated |
| `checks-failed`, `checks-failed-twice` | The phase's checks failed once, or twice |
| `report-weak` | A report lacks the evidence it was asked for |
| `conflict` | Reports contradict each other |
| `stuck` | A worker stopped at a decision it could not make |
| `no-pass` | No attempt passed |
| `findings-left` | Confirmed review findings remain |

In skill-only mode Claude and Codex quota conditions use fresh `usage` readings. Their extra
windows apply only when reported. For Antigravity and Kimi, quota conditions still need Alethe or
the user; for other providers, ask the user. A stale or absent reading cannot establish an
`above` or `spare` condition. `conserveProviders` and explicit user warnings still establish low.
Spare quota also needs a reset time; a non-renewing plan end comes from `quota.planEnds` or the
user. Ignore a `planEnds` date that has passed. Task, check and report conditions are judged by
the lead from evidence; budget conditions, `spent-above` among them, use the plan's recorded spend.
`price-above` reads the price table `models` shows: the bundled `prices.json` overlaid by
`alethe-prices.json` next to the policy, keyed `provider/model`. It is a planning choice the lead
makes before the wave.

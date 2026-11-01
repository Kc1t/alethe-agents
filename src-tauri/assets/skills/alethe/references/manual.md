# Orchestrating without Python

Use this path when Python 3.9+ is not installed or the user asked not to depend on it. You do what
`scripts/orchestrate.py` would do with your own shell and file tools. The playbooks, tiers, worker
contract and token discipline in SKILL.md stay the same; only the mechanics change.

## 1. Detect

Run these yourself, in one batch, and keep only the answers:

| What | How |
| --- | --- |
| Python | `python --version`, `python3 --version`, `py --version`; any 3.9+ means the runner is an option |
| Worker CLIs | `<cli> --version` for `claude`, `codex`, `agy`, `kimi`, plus any other agent CLI on PATH |
| Logged in | a one-word prompt on the cheap tier, only for a CLI you plan to use; an auth error means "log in first" |
| Git | `git rev-parse --show-toplevel` and `git status --porcelain`; worktrees need a repository |
| Saved setup | the playbooks copy, `alethe-playbooks.yaml` in `%APPDATA%\Alethe\` on Windows or `~/.config/alethe/` elsewhere; otherwise `playbooks.yaml` in this skill |
| Routes | for 9router or another gateway, read its config or environment; never start or change it |

Read only the playbooks file's active `profile`, provider order, `pickOrder` and playbook summaries
first, then the chosen playbook, resolved `tiers` plus profile overrides, and quota/budget rules.
This is the manual equivalent of `playbook --pick`, then `playbook <id>`. Read the whole file only
for editing or onboarding. Existing deprecated `policy.modelTiers` overrides still win; write new
tiers only to the playbooks copy. With no saved copy, follow [onboarding.md](onboarding.md) using
this inventory instead of `doctor`, and save the approved copy at the path above.

## Quota and prices without the runner

Before every wave, read Claude quota from the latest `rate_limit_event` left by each Claude
worker. Read Codex quota from the latest quota data in its own session files under its home
directory; do not start a worker to get it or expect it in the worker's stdout. Claude is only as
fresh as its last worker event; Codex is freshly read. Keep each provider/window's `usedPercent`,
`resetsAt`, `ageMinutes`, `low` (>= active `quota.criticalThreshold`), `blocked`
(>= `quota.stopAt`), `stale` (>30 minutes) and `reset` in `alethe-usage.json` next to the policy.
Missing or stale data is unknown; say when stale. With no Claude worker event in the last 30
minutes, a one-line Haiku call with `--output-format stream-json --verbose` prints a fresh one.
Antigravity and Kimi still need Alethe or the user; ask the user for other providers' readings.

Use those readings exactly as the skill's "Watch the quota" section says: move unpinned low
providers to the next capable provider at the same tier, and apply `quota.whenSpare` when unused
quota would be lost, under every goal, profile and runner strategy. Tell the user at most one
quota line per wave with the readings and reset time; append the switch and reason to `state.md`.
Without the runner you enforce the stop line: start no worker on a blocked provider, and check
again before each queued worker. After each wave, note what each worker took of each window, and
forecast the next wave from those notes. When the stop line, the forecast or a lower tier is at
stake, ask the user with the options that section lists.

Read bundled `prices.json` and overlay `alethe-prices.json` next to the policy. Prices are USD per
1M tokens with official `source` and `asOf` on every entry. For the manual `models` view, list each
provider's models, price, relative `low`/`mid`/`high` rank, `asOf`, stale (>60 days) and missing.
For a needed missing or stale price, look it up only on the vendor's official pricing page, tell
the user, and write the verified entry with `source` and `asOf` into `alethe-prices.json`. Never
guess. An unpublished price stays unknown.

During onboarding ask once per provider whether billing is `subscription` or `api`, skipping saved
answers, and save approved choices as `billing: {<provider>: "subscription" | "api"}` in that
prices copy. Subscription spend is quota percent; API spend is the price. Any preview dollars
must be labeled a list-price estimate; the report shows only what the CLIs reported.

## 2. Offer options

Before the first wave, show the user what you found and two to four concrete options, recommended
first, each in one line with who does what and why it saves. Ask them to pick when the choice
changes cost or touches their files. Build the options from `pickOrder` and the inventory, for
example:

- **Do it myself:** the task is small enough that briefing workers costs more.
- **Plan big, execute small:** N cheap read-only workers on CLI X, I write the answer.
- **Parallel writers:** N writers in their own worktrees on CLI X and Y, I integrate and test.
- **Use the runner:** Python is installed, so `scripts/orchestrate.py` can add budgets, dry-run
  estimates and the report.

When the user already named a playbook, runner strategy or provider, skip the question and say in one
line what you will run.

## 3. Prepare the run folder

Create `<folder>/<NN>-<phase>/<worker-id>/` outside the repository, for example under the system
temp folder. For each worker write `task.md`: the brief from [briefs.md](briefs.md), followed by the
worker contract invariants from SKILL.md word for word. For each concurrent writer create a
worktree first: `git worktree add .alethe/worktrees/<run>-<id> -b alethe/<run>-<id>` and add
`.alethe/worktrees/` to `.git/info/exclude` when it is not ignored yet.

## 4. Launch the workers

Start each worker as a background process with `ALETHE_ORCHESTRATE_WORKER=1`, the prompt from
`task.md`, stdout to `out.jsonl` and stderr to `err.log`, and the tier's model and effort pinned.
Launch every worker of a wave in one go, at most four at a time. Never run a wave in the foreground
of a shell tool with a short timeout; wait for the background processes to finish.

```text
codex --disable multi_agent exec --sandbox read-only|workspace-write --json --output-last-message result.md --cd <cwd> --model <m> --config model_reasoning_effort=<e> --config mcp_servers={} -  < task.md
claude --print --output-format stream-json --verbose --permission-mode plan|acceptEdits --disallowedTools Agent,Workflow --strict-mcp-config --model <m> --effort <e>  < task.md
agy --output-format json --mode plan|accept-edits --print-timeout <s>s --add-dir <cwd> --model <m> "--print=<task>"
kimi --output-format stream-json --model <m> "--prompt=<task>"
```

- Drop `--model` or `--effort` only when the tier leaves it empty. Check `--help` once for flags you
  are unsure about; if `codex features list` has no `multi_agent`, drop that `--disable`.
- Add `--skip-git-repo-check` to Codex outside a git repository.
- Give each process a deadline: `timeout <s>` in bash, or a `Start-Process` handle you stop after
  `<s>` seconds in PowerShell. In Claude Code, launch with `run_in_background` and wait for the
  completion notice. With the Python runner, use `run <plan> --in current --detach` and repeat
  `wait [--timeout N]` (maximum 540 seconds per call) until `done` is true.
- Agy and Kimi take the task as an argument; keep it short and point to files instead.
- Never use bypass flags such as `--dangerously-skip-permissions` or `--yolo` unless the user asked.

## 5. Read results

Read only what the report needs, never the full stream:

| CLI | Final answer | Tokens and cost | Session id |
| --- | --- | --- | --- |
| Claude | last line with `"type":"result"`, its `result` | `usage`, `total_cost_usd`, `modelUsage` | `session_id` |
| Codex | `result.md` | `usage` on the `turn.completed` events | `thread_id` on `thread.started` |
| Agy | `result` in the JSON | when present | `conversation` id when present |
| Kimi | last assistant message | when present | `session` id when present |

Keep cache reads separate from other reported tokens. Codex `input_tokens` includes
`cached_input_tokens`, so subtract those reads for the non-cache total; Claude reports
`cache_read_input_tokens` separately, so leave it out of the total. Keep cache writes in the
total. Exclude cache reads from `maxReportedTokens` and the Value token split; do not subtract any
cache charges from the cost the CLI reported.

Check the `STATUS:` line, then the diff with `git -C <worktree> diff`. A status is a claim; the diff
and your checks decide. A read-only worker that changed files counts as a failure. A `429`, "rate
limit" or "usage limit" in `err.log` means the unit moves to the next provider in the order at the
same tier, as `quota.whenLow` says.

## 6. Integrate and report

Merge or apply the diffs you accept, run the project's checks in the combined checkout, then remove
the worktrees and branches whose changes you handled. Write `<folder>/report.md` and show it:

| Worker | CLI and model | Why | Status | Time | Tokens | Cache reads | Cost | Used |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Add the totals, what the spend bought, and what is left to review. Split non-cache tokens and
reported cost between used, partial and discarded results; show cache reads separately. Show cost
only where the CLI reported it; never turn the price table or a preview estimate into report spend.

When the user wants the report as a page, write `<folder>/report.json` with what you counted and
copy `assets/report.html` to `<folder>/report.html` with its line `__REPORT_JSON__` replaced by
that JSON, through the shell as for the editor (`sed -e '/__REPORT_JSON__/{r report.json' -e 'd}'`).
Write any `</` in it as `<\/`. The page computes totals and the split per provider, so each worker
needs only what you know; use `null` for anything its CLI did not report:

```json
{"title": "Audit the auth module", "why": "...", "playbooks": ["audit-at-scale"],
 "lead": {"provider": "claude", "model": "opus"},
 "startedAt": "2026-10-23T13:00:00Z", "finishedAt": "2026-10-23T13:04:10Z",
 "journal": [{"at": "2026-10-23T13:02:00Z", "kind": "skip", "text": "Skipped settle: the scouts agreed"}],
 "runs": [{"phase": "audit", "why": "...", "status": "done", "startedAt": "2026-10-23T13:00:00Z",
   "wallSeconds": 95, "workers": [{"id": "audit-a", "why": "...", "provider": "codex",
   "model": null, "effort": "low", "mode": "read-only", "status": "succeeded",
   "durationSeconds": 80, "tokens": 41000, "cachedTokens": null, "costUsd": null,
   "summary": "...", "mark": "used"}]}]}
```

## What you lose without the runner

- No hard budget: count calls and reported tokens yourself after each wave and stop at the limit.
- No automatic `dry-run`: estimate prompt tokens as task characters divided by four. A dollar
  estimate may use verified prices only; label it a list-price estimate, never actual spend.
- No `diagram.py`: draw the plan as a Mermaid flowchart when the user wants to see it.
- No `editor`: copy `assets/editor.html` and replace its line `__PLAYBOOKS_YAML__` with the full
  text of the effective playbooks file (the user's `alethe-playbooks.yaml` next to the policy, else
  the bundled `playbooks.yaml`), writing any `</script` in it as `<\/script`. Use the shell rather
  than reading the 180 KB page: `sed -e '/__PLAYBOOKS_YAML__/{r <yaml>' -e 'd}' <template> > <page>`,
  or in PowerShell `(Get-Content -Raw <template>).Replace('__PLAYBOOKS_YAML__', (Get-Content -Raw
  <yaml>)) | Set-Content <page>`. Optionally put the quota you read in the `live-usage` block, as
  `{"claude": {"short": 26, "week": 69, "opus": 0, "reset": 49}}` (percent used; `reset` is hours
  until the weekly window resets). To simulate `price-above`, optionally put the price table in the
  `model-prices` block, as `{"claude/sonnet": {"input": 2, "output": 10}}` (USD per 1M tokens).
  Open the page; a red line at the top names a YAML error.
- No Windows `.cmd` shim handling: run the commands through your own shell, which handles the shim,
  and keep newlines and quotes inside `task.md` rather than in arguments.
- No `status` or `mark`: keep `<folder>/state.md` with one line per worker (id, phase, status,
  used, partial or discarded) so a compacted session can pick up from it.

## Short commands without the runner

| Words | Do |
| --- | --- |
| `report`, `status` | show `report.md`, or the latest lines of `state.md`, plus the quota summary |
| `usage` | read quota sources and show windows, reset times and freshness as above |
| `models` | show the model and price view above; refresh needed stale or missing entries |
| `list`, `use <folder>` | list the run folders under the temp folder, newest first; remember the one picked |
| `stop` | stop the background worker processes of the current folder |
| `budget <limit>` | write the limit at the top of `state.md` and check it after every wave |
| `note <text>`, `mark <worker> <mark>` | append it to `state.md`; the report lists notes under "Changes to the plan" |
| `on`, `off`, `save`, `balanced`, `max`, `freestyle`, `careful` | keep the mode, goal, care level and rules in this conversation; after a compaction, ask the user whether it is still on |
| `setup` | section 1, then [onboarding.md](onboarding.md) |

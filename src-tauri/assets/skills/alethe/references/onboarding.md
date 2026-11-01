# Orchestration onboarding

Use this when the user asks to set up the skill or `doctor` finds no saved policy. The result is a
playbooks copy that lists what the user really has, three profiles built from it, and the user's
approval, plus billing choices in `alethe-prices.json` next to the policy. Ask only what you cannot
find out; skip answers already given or saved in the policy, playbooks or prices copy.

## 1. Take inventory

1. Run `doctor` for the built-in CLIs: Codex, Claude Code, Agy / Antigravity and Kimi Code. A CLI
   with `loggedIn: false` goes in the notes with "log in first", not in `providers`; a run on it
   would fail with `auth_required`.
2. Look on PATH for other agent CLIs, such as `gemini`, `kiro-cli`, `copilot` or `opencode`, and for
   routes such as `9router`. Run each one's `--help` before counting it; a CLI that fails to start
   goes in the notes with the fix, not in `providers`. Ask: "Is there another AI CLI or routing
   tool you want to use?" Accept a name or executable path.
3. List each CLI's models when it has a command for that, such as `agy models` or
   `kiro-cli chat --list-models --format json`. Keep cost multipliers the CLI reports. Codex keeps
   its list in `models_cache.json` under its home folder (`~/.codex` by default); read that file
   instead of starting a session.
4. Record a custom adapter only after `--help` shows a non-interactive prompt mode, and write down
   the command you checked. Never guess flags or credentials. A custom adapter cannot enforce
   read-only work, so it only takes writing phases; see [providers.md](providers.md).
5. Run `usage`: Claude readings come from worker `rate_limit_event` events and Codex readings from
   its session files, without Alethe. Antigravity and Kimi still need Alethe or the user; ask for
   other providers' usage and plan end dates only when quota rules need them. Disclose stale data.
6. Ask once per provider: "Is <provider> billed by subscription or API?" After approval, save the
   answer as `billing: {<provider>: "subscription" | "api"}` in `alethe-prices.json` next to the
   policy, preserving price entries. With subscription billing, quota percent is what is spent;
   with API billing, the model price is. Skip providers whose billing choice is already saved.
7. Run `models` for model prices and relative `low`/`mid`/`high` ranks. For any needed missing price
   or price older than 60 days, look it up only on the vendor's official pricing page, tell the
   user, and save the entry with `source` and `asOf` in `alethe-prices.json`. Never guess a price.
8. For a route such as 9router, record whether it is installed and running and which CLIs the user
   wants it to carry. A route is a separate diagram node, not a worker. Inspect the app
   configuration or environment before calling it active, and never start, install or reconfigure
   it.

## 2. Build three profiles

Write three profiles over the same playbooks, using only models the inventory found:

| Profile | Tiers | Order | Switches at | Stops at |
| --- | --- | --- | --- | --- |
| `base` | Each CLI's usual model per tier | The user's main CLIs first | 80% | 95% |
| `savings` | One step cheaper per tier; low-multiplier and separate quotas for volume | Cheapest capable CLI first, the scarcest subscription last | 70% | 90% |
| `aggressive` | One step stronger per tier; `xhigh` still only on escalation | The strongest CLIs first | 95% | 98% |

Choose explicit models where possible. If the user wants a CLI default, leave the model empty and
explain the `validate`/`dry-run` warning, even when effort is set. Put a read-only phase only where
the CLI enforces it. Write tiers only to the playbooks copy, never to `policy.modelTiers` or with
the deprecated `policy set --cheap-model` path; existing policy tier overrides still win.

## 3. Ask for approval

Show the inventory in a few lines: found, skipped with the reason, and routes. Then show one table
with the three profiles and the model each tier gets on each CLI. Recommend one and ask: "Approve
these profiles, and which one should be active?" Apply changes and show the table again. Never
save or start workers before the user approves.

## 4. Save

1. Run `playbook --init`, adding `--force` only after the user agreed to replace an existing copy,
   and edit the copy it prints: `setup` (date and notes), `providers`, `models`, `adapters`,
   `routes`, `tiers`, `profiles` and `profile`, as [playbooks.md](playbooks.md) describes.
2. Save the approved provider billing choices in `alethe-prices.json` if not already saved. Run
   `doctor` to validate the playbooks copy, then `policy set --provider-order` with the active
   profile's built-in CLIs, or `policy set` with no options when the defaults fit, so `doctor`
   records onboarding as complete. A choice limited to one run stays out of the policy.
3. Ask once: "Keep orchestration on in every project, so you never have to call it?" On yes,
   run `mode on --everywhere`. Suggest goal `save` for profile `savings`, goal `max` for profile
   `aggressive`, or goal `balanced` for profile `base`, and goal `freestyle` when they only want it
   to watch cost and suggest; the goal controls delegation, independently of the profile's tier
   models. It can be turned off per project later.
4. Offer a preview diagram of the active profile.

Later, "use savings" or "go aggressive" changes `profile` in the copy; confirm it when it is an
ongoing change, or apply it to this run only.

## Ready-made routes

These are starting points for a wave's runner strategy, not claims that a model is available or
cheapest. Always `probe` before selecting a worker; the local CLI and the user's request take
precedence.

| Purpose | Suggested plan | Typical provider choice |
| --- | --- | --- |
| Save usage | One bounded reader or writer, `economy`, cheap tier when configured | First available preferred CLI |
| Everyday work | Two independent units, `balanced` | Codex and Claude Code, or two isolated units on one CLI |
| Independent review | Writer, then reviewer, then repair only if needed, `quality` | Review with a different available CLI when possible |
| Compare findings | Two or more read-only investigations, `research` | Mix available CLIs for independent views |
| Implement independent pieces | Disjoint writers in isolated worktrees, `parallel` | Available writing CLIs with explicit file ownership |
| Recover a session | One resumed worker, `rescue` | The same CLI that owns the session ID |

9router routes an agent's API traffic and can be drawn between that agent and its upstream model.
It does not replace the CLI adapter or reveal which upstream model a request used unless that
information is available from the configuration or observed run data.

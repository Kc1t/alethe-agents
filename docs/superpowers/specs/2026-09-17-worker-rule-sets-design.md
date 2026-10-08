# Worker rule sets — Design

Date: 2026-09-17
Status: approved in conversation, pending spec review

## 1. Problem

Alethe delegates work to other agents, and what comes back is only as good as what they were told.
Today a worker receives the task text and nothing else: no standard for how code is written here, no
reminder to verify before reporting, no shared idea of what "done" means. Every worker improvises,
and the person reviewing the board pays for it.

The knowledge exists — the owner's other projects carry hard-won rule files — but it lives in those
repositories, so it never reaches a worker running anywhere else, and a new project starts from
nothing.

## 2. Goals

- Alethe ships **good engineering rules of its own**, handed to every worker it starts.
- Rules are **named sets** (General, Backend, Frontend, plus any the person creates), so a worker
  gets what its work needs and nothing else.
- The **planner picks the set** when it delegates, because it knows what the task is.
- The person **edits ours and adds their own**, per user, from Preferences.
- A repository's own conventions always **win** over Alethe's.

## 3. Non-goals

- No stack-specific defaults. Ours are neutral; a stack-specific set is something the person adds.
- No per-project rule storage. Sets are per user and travel with them; per-project convention is
  what `CLAUDE.md` / `AGENTS.md` already are.
- No enforcement. Rules are instructions to an agent, not lint. Nothing blocks a worker that ignores
  them.
- Native subagents (the ones a CLI spawns inside its own process) are out of reach and get nothing.

## 4. The model

### 4.1 A rule set

```ts
export type RuleSet = {
  /** Stable identity. `general`, `backend` and `frontend` are ours; a new one gets a random id. */
  id: string
  /** What the planner names when delegating. Unique, matched case- and accent-insensitively. */
  name: string
  /** Markdown handed to the worker verbatim. */
  text: string
}
```

**General is special.** `id: 'general'` always applies, on top of whatever else is chosen. It cannot
be deleted or renamed — only edited, with "restore ours" beside it. Every other set is free: create,
rename, edit, delete.

**Names are the interface.** The planner selects by name, so names must be unique. Matching folds
case and accents (`banco de dados` finds `Banco de Dados`), because an agent typing a name is one
keystroke away from a failed call.

### 4.2 Storage

`Preferences.workerRuleSets: RuleSet[] | null`, default `null`, saved per user with the rest of the
preferences.

`null` means "never customized: use Alethe's". Any array — **including an empty one** — is the
person's own list. This is the same distinction the message shortcuts learned the hard way: an empty
array that means "use ours" makes deleting the last item silently resurrect everything.

`resolveRuleSets(stored, defaults)` returns `defaults` only for `null`/`undefined`.

### 4.3 Where ours live

`src-tauri/assets/rules/general.md`, `backend.md`, `frontend.md`, shipped as assets and read at
startup, the way `planner-guide.md` already is. They are **not** locale message entries: they are
long prose read by an agent, not UI strings, and putting 20-line documents in the message catalogue
would make both files unreadable. The editor shows them as they are, and the person may rewrite them
in any language they like — the worker reads what is stored.

UI labels around them (section title, buttons, counters) go through `t()` in both locales as usual.

### 4.4 The editor

A section in **Preferences → Multiagent**, under the message shortcuts, since both answer the same
question: how delegated work behaves.

One card per set: name, text, and per-card actions (restore ours where a default exists, delete
where allowed). A button adds a set. Beside the text, a character count — the text travels with
every task of that area, so its cost should be visible while it is being written.

## 5. How the planner learns and chooses

### 5.1 The briefing

`planner_instructions` already tells the planner which workers exist and how many run at once. It
gains the set names and the rule:

```
Rule sets available: General (always applied), Backend, Frontend, Banco de Dados.
- When you delegate, name the set that matches the work. Omit it and the worker gets General only.
```

Built from live state, so a set the person deleted is never advertised.

### 5.2 Delegation

`alethe_delegate` gains an optional `rules` parameter: one set name for the whole call.

- **Named and known:** that set plus General goes to every worker in the call.
- **Omitted:** General only.
- **Named and unknown:** the call is **rejected** with the list of valid names and no worker starts.
  One round trip is cheaper than three workers doing the wrong thing quietly, and the error carries
  its own fix.

A mixed batch is two calls. That reads better on the board too: one run per area.

### 5.3 Reading a set on demand

`alethe_rules` returns a set's text by name, or the list of names when called without one — the same
shape as `alethe_guide`. This is how the planner follows the rules when it writes code itself,
without every planner prompt paying for rule text it usually does not need.

### 5.4 On the board

A run node shows the rule set it was delegated with. When a worker comes back off-standard, the
board answers "was it given the wrong rules, or did it ignore the right ones?" without a hunt.

Mechanically: the job records the set's name at creation — the name as resolved, not as typed — and
`Inner::snapshot` emits it beside the other job fields, so the board reads it from the snapshot it
already receives. A job delegated without a set reports none, and the node says so rather than
implying General was absent.

## 6. How rules reach the worker

Prefixed to the **first message only**, delimited:

```
<alethe-rules>
These are Alethe's working rules for this task. If this repository states something different
(CLAUDE.md, AGENTS.md, CONTRIBUTING.md), the repository wins.

# General
…

# Frontend
…
</alethe-rules>

<task>
…
</task>
```

Follow-up messages to the same worker (`alethe_send`, `alethe_steer`) repeat nothing: the rules are
already in that conversation.

**Why a prefix and not a system prompt.** Both worker backends receive work over stdin — Codex as an
app-server, Claude in stream-json mode — and no flag exists for both. A prefix works identically for
each, and has a second virtue: the rules are visible in the worker's transcript, so what it was told
can be audited.

**Who supplies them.** `orchestrator_core` stays Tauri-free, so the app injects the resolved sets
into it, the same pattern used for worker launchers and the shell host. The core stores them and
composes the block at delegation time.

**Size.** Nothing is truncated on delivery: a silently cut rule becomes wrong behaviour, which is
worse than an expensive prompt. The editor shows the character count and warns when a set grows
large; the cost stays the person's to see and decide.

## 7. What ours say

Shipped verbatim as the three assets. Each line is one imperative; the sets are deliberately short
because they travel with every task.

### General

- Understand before you change: read the code around what you touch and follow the file's patterns,
  not your preferences.
- Make the smallest change that solves it. No unrequested cleanups along the way.
- Look for an existing helper or component before writing another; promote code to a shared place
  only when a second consumer needs it.
- Record an architecture decision as a versioned ADR committed in the same change: context,
  alternatives rejected, consequences. A decision that lives only in your head is next quarter's
  rework. From now on only — do not document past decisions retroactively.
- Validate at the boundary and fail fast. Do not add a defence that masks a value you know is there:
  it delays the failure and erases the evidence.
- No magic strings or numbers: a domain value becomes a named constant, and lists derive from that
  single source.
- Avoid nesting: guard clauses and early returns; never `else` after `return`.
- Do not mutate parameters or shared state — transform and return.
- Write the failing test first and watch it fail for the right reason. Name the test after the
  acceptance criterion, and cover a happy path and an error path.
- A green suite is not proof it works: exercise it the way the person will before calling it done.
- Confirm the verification verified: check that the command actually covered the files you changed.
- Never weaken shared lint, hooks or CI to make your change pass. Fix the code.
- Before trusting a mock of an external dependency, observe the real thing once and mirror what you
  saw, not what you assumed.
- In a design document, cite only symbols you actually opened, with file and line; mark anything
  unverified as unverified.
- No debug prints in what ships — use the project's logger.
- No fire-and-forget async that swallows failure: await it, return it, or handle it.
- Comments explain the non-obvious why, at the density the file already uses.
- If you generated an artifact a person will open, open it back and check its content and format.
- Do not commit, push or touch version control unless asked. Secrets never enter code or logs.

### Backend

- Layer strictly: the entrypoint validates and delegates, the service orchestrates without touching
  the datastore, and one data-access layer talks to the database.
- Every connection to an external resource goes through one owned client — pool, timeout and circuit
  breaker in one place, never the raw driver spread across the code.
- Always parameterized queries. Concatenating a value into a query is a defect.
- Release every resource — connection, lock, file handle — in a `finally`, not only on the happy
  path.
- Every `catch` funnels into one handler that preserves the intended status and converts the unknown
  into a safe error. Never swallow, never return empty from a catch, never rethrow raw.
- No stack trace reaches the client: map failures to the right status and a safe message.
- The API is the source of truth for business rules. Never assume the client already validated.
- Datastores are read-only by default; a write needs explicit per-case authorization, and check the
  target is really local. "Dev" in a name does not mean safe.
- A schema-changing or seeding command never points at a shared database.
- A bug is confirmed when an automated test reproduces it through the real path. The regression test
  asserts the correct behaviour — failing now, passing after the fix.
- Test the real HTTP layer, not only a service with a mocked dependency: a wrong route or a missing
  middleware never shows up in a mock.
- User-facing and error messages live in one place, ready for translation.

### Frontend

- A new screen ships with an end-to-end test in the same change, walking the flow the way a person
  walks it.
- The server is the authority; client-side validation is for responsiveness, not truth.
- Use the project's design-system primitive before hand-building a button, table or dialog.
- Server data goes through the app's data layer — no ad-hoc HTTP call inside a component.
- Do not fetch in a mount effect; effects are for real side effects (focus, subscriptions), each
  with a line saying why.
- Componentize: screens assembled from small components, logic in hooks, no god component.
- Accessibility and responsiveness are not extras: no horizontal overflow at standard widths, and
  every interactive element carries a label.
- The contents of a modal, tab or accordion load when it opens, not when the page mounts — confirm
  in the network tab that the request waits for the click. If the page needs part of that data, give
  it its own light endpoint.
- Open it in a real browser and interact — filter, paginate, empty, loading — before calling it
  done. For a visual bug, read the computed style; it beats a screenshot.
- The screen shows the real state: loading, empty and error too.
- Visible copy and error-message extraction live in one place.

## 8. Testing

Decisions live in pure functions with unit tests; the UI and the core plumbing stay thin.

- `resolveRuleSets`: `null`/`undefined` returns the shipped defaults; `[]` returns `[]`; a stored
  list returns as-is.
- Name matching: case and accent folding; a duplicate name is refused by the editor.
- `general` cannot be deleted or renamed by the editor's actions.
- Rust: composing the delegation block — General alone when no set is named, General plus the named
  set when one is, and the precedence line present in both.
- Rust: an unknown name rejects the call, names the valid sets, and starts no worker.
- Rust: `planner_instructions` lists exactly the sets that exist.
- The i18n of the surrounding UI is covered by the build's locale parity check.

## 9. i18n, changelog, house rules

UI labels go in `en.ts` and `pt-BR.ts`. The rule assets are English prose the person may rewrite.
`docs/CHANGELOG.md` gains an `[Unreleased]` entry describing, in the person's terms, that Alethe now
hands its own engineering rules to the agents it delegates to, and where to edit them. Styling stays
on CSS Modules and theme tokens.

## 10. Alternatives rejected

- **Rules per task instead of per delegation call.** More flexible, but it turns the task list into
  objects and gives the planner one more thing to get wrong for a case that splits cleanly into two
  calls.
- **Alethe guesses the area from the task text.** No friction and no reliability: a task mentioning
  "the API component" picks the wrong set and nobody notices.
- **One big rule set instead of named ones.** Cheapest to author, worst to use: a frontend worker
  reads database migration rules forever.
- **The planner receives the general set in its briefing.** It would never write off-standard code
  itself, but every planner prompt pays for it, including the majority where it only delegates.
- **Stack-specific defaults.** Concrete and excellent inside one stack, wrong everywhere else —
  which is exactly where delegation goes. Stack specifics are what a custom set is for.

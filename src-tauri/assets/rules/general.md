# General

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

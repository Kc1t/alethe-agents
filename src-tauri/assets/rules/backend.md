# Backend

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

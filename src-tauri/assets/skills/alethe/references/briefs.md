# Briefs and reviews

Read this reference when writing a worker's task, or a review, validation, judge or panel brief.

## Is the brief ready?

A vague brief is the most expensive part of an orchestration: every worker pays for it, and the
retries pay again. Score it before sending:

| Part | Score |
| --- | --- |
| Task goal | 0 missing, 1 vague, 2 clear, 3 clear and testable |
| Expected result | 0 missing, 1 vague, 2 clear, 3 checkable by a command or a diff |
| Scope | 0 none, 1 a direction, 2 the paths it owns and the ones it must not touch |
| Constraints | 0 none, 1 some, 2 the repository rules and limits that apply |

Below 7, read more or ask the user before sending anything.

## A writer's brief

In this order:

1. One line on where the unit fits in the whole task.
2. The task goal and the definition of done, written as checks that pass or fail.
3. The paths it owns, and what it must leave untouched.
4. Interfaces and decisions from earlier waves that it cannot discover by itself.
5. How you resolved any ambiguity you noticed in the request.
6. The checks to run, with their exact commands.

A brief describes one unit, not the session's history. Point to files instead of pasting them.

The runner appends the worker contract, which ends with a `STATUS:` and a `SUMMARY:` line. Treat
`BLOCKED` and `NEEDS_CONTEXT` as a question back: change the context, the tier or the scope before
sending the unit again, and never resend the same brief to the same model.

## Checking a writer's work

- Check the repository, not the worker's report. Its summary and its status are claims.
- Read changes to tests first. A check that turned green because it was weakened is a failure.
- Passing checks are necessary, not sufficient.
- In a checkout with changes, look at `git diff` and the untracked files before any checkout, reset
  or clean.
- Ask for rework with the delta: the finding and the expected behavior, not the whole task again.
- You integrate and commit. Workers never do.

## A reviewer's brief

Hand the reviewer the task, the worker's `result.md` and its `diff.patch` by path. Ask for:

1. The spec first: what is missing, extra or misunderstood. "Cannot verify from the diff" is an
   answer; a guess is not.
2. Then quality: each finding with file:line, a failure scenario and a severity (critical, high,
   medium or low).
3. Nothing else: every line is a finding, a verdict or a check the reviewer ran.

One strong finding is worth more than several weak ones, and a stated rationale never lowers a
finding's severity. Keep reviewers on the standard tier or above. Cheap models miss real defects
and defend planted ones, so they only skip trivial diffs.

## Adversarial review

For a change that must not fail, ask the reviewer to look for reasons it will fail, not reasons it
works. Point it at trust boundaries, data loss, retries and idempotency, races and stale state,
empty, null and timeout paths, schema drift and missing observability. Each finding answers: what
can go wrong, why this path is exposed, the likely impact, and the change that lowers the risk.
It approves only when no substantive finding survives.

## Validator verdicts

A validator checks claims it did not make, in a new session: never resume the author's session
for it. It ends with:

```text
VERDICT: PASS | FAIL | NOT_PROVEN
NOT CHECKED: <criteria nobody demonstrated, or none>
```

PASS needs every criterion demonstrated and nothing left unchecked. FAIL means a failure was
shown. NOT_PROVEN means evidence is missing, so run the missing check before fixing anything. The
runner reads the `VERDICT:` line into `outcome.json`, and the report flags FAIL and NOT_PROVEN.

## Re-review

After a fix, review only the fix's diff and mark each earlier finding ADDRESSED or NOT ADDRESSED.
An attempt that leaves the defect in place is not addressed.

## A panel

For a decision rather than a diff, give the same brief to two or three providers, each in its own
session, without showing them each other's answers. Give each a stance: one argues for, one
against, one stays neutral. The one arguing for still names at least one real reason; the one
against does not oppose a sound idea just to disagree; the neutral one reports the real balance,
not an even split. Each ends with its verdict and a confidence out of 10. You then write the
agreement, the disagreement and why, the recommendation and the risks.

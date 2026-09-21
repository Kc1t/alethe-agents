import type { PullRequestSummary } from './tauri'

export type MergeGuardErrorKey =
  'merge.prStaleError' | 'merge.prDraftError' | 'merge.prConflictError'

export type MergeGuardResult =
  { ok: true; latest: PullRequestSummary } | { ok: false; errorKey: MergeGuardErrorKey }

/**
 * Concurrency guard evaluated right before a squash merge: re-fetches the
 * open PRs for the head branch and blocks the merge if the head commit moved
 * since the review, the PR is a draft, or GitHub reports it as conflicted.
 * Checked in this order because a stale/moved head makes the other two
 * checks meaningless (they'd be evaluated against outdated PR state).
 */
export function evaluateMergeGuard(
  expected: Pick<PullRequestSummary, 'number' | 'headSha'>,
  latestOpenPrs: PullRequestSummary[],
): MergeGuardResult {
  const latest = latestOpenPrs.find((item) => item.number === expected.number)
  if (!latest || latest.headSha !== expected.headSha) {
    return { ok: false, errorKey: 'merge.prStaleError' }
  }
  if (latest.isDraft) {
    return { ok: false, errorKey: 'merge.prDraftError' }
  }
  if (latest.mergeState === 'DIRTY') {
    return { ok: false, errorKey: 'merge.prConflictError' }
  }
  return { ok: true, latest }
}

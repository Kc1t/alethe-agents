import { describe, expect, it } from 'vitest'

import { evaluateMergeGuard } from './pullRequestMerge'
import type { PullRequestSummary } from './tauri'

function makePr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 42,
    title: 'Add feature',
    body: '',
    url: 'https://github.com/example/repo/pull/42',
    baseBranch: 'main',
    headBranch: 'feature/x',
    headSha: 'abc123',
    mergeState: 'CLEAN',
    isDraft: false,
    author: 'someone',
    reviewDecision: null,
    ...overrides,
  }
}

describe('evaluateMergeGuard', () => {
  it('allows the merge when the head is unchanged, not a draft, and clean', () => {
    const expected = makePr()
    const result = evaluateMergeGuard(expected, [expected])

    expect(result).toEqual({ ok: true, latest: expected })
  })

  it('blocks as stale when the PR is no longer in the open list', () => {
    const expected = makePr()
    const result = evaluateMergeGuard(expected, [])

    expect(result).toEqual({ ok: false, errorKey: 'merge.prStaleError' })
  })

  it('blocks as stale when the head commit moved since the review', () => {
    const expected = makePr({ headSha: 'abc123' })
    const latest = makePr({ headSha: 'def456' })
    const result = evaluateMergeGuard(expected, [latest])

    expect(result).toEqual({ ok: false, errorKey: 'merge.prStaleError' })
  })

  it('blocks drafts even when the head commit still matches', () => {
    const expected = makePr()
    const latest = makePr({ isDraft: true })
    const result = evaluateMergeGuard(expected, [latest])

    expect(result).toEqual({ ok: false, errorKey: 'merge.prDraftError' })
  })

  it('blocks conflicted PRs even when the head commit still matches', () => {
    const expected = makePr()
    const latest = makePr({ mergeState: 'DIRTY' })
    const result = evaluateMergeGuard(expected, [latest])

    expect(result).toEqual({ ok: false, errorKey: 'merge.prConflictError' })
  })

  it('prioritizes the stale check over draft/conflict state', () => {
    const expected = makePr({ headSha: 'abc123' })
    const latest = makePr({ headSha: 'def456', isDraft: true, mergeState: 'DIRTY' })
    const result = evaluateMergeGuard(expected, [latest])

    expect(result).toEqual({ ok: false, errorKey: 'merge.prStaleError' })
  })

  it('ignores PRs with a different number in the open list', () => {
    const expected = makePr({ number: 42 })
    const otherPr = makePr({ number: 7 })
    const result = evaluateMergeGuard(expected, [otherPr])

    expect(result).toEqual({ ok: false, errorKey: 'merge.prStaleError' })
  })
})

import { invoke } from '@tauri-apps/api/core'

export type PullRequestSummary = {
  number: number
  title: string
  body: string
  url: string
  baseBranch: string
  headBranch: string
  headSha: string
  mergeState: string
  isDraft: boolean
  author: string
  reviewDecision: string | null
}

export async function githubPrFind(
  repo: string,
  headBranch: string,
): Promise<PullRequestSummary[]> {
  return invoke<PullRequestSummary[]>('github_pr_find', { repo, headBranch })
}

export async function githubPrMerge(
  repo: string,
  number: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
  expectedHeadSha?: string,
): Promise<string> {
  return invoke<string>('github_pr_merge', { repo, number, method, expectedHeadSha })
}

export type MyPullRequestSummary = {
  number: number
  title: string
  url: string
  repo: string
  author: string
  isDraft: boolean
  updatedAt: string
}

export async function githubPrListMine(): Promise<MyPullRequestSummary[]> {
  return invoke<MyPullRequestSummary[]>('github_pr_list_mine')
}

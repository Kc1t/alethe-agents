import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "A folder with nothing in it" — fixture project for Part 4 of the Merge
 * Center plan. Created from scratch on every run (never reused between runs,
 * never committed to the Alethe repository): a truly empty folder
 * doesn't survive git (empty directories aren't versioned), and reusing a
 * fixed folder would accumulate history from previous runs, breaking the
 * premise of "always starts empty, with no `.git`".
 */
export function createEmptyFixtureProject(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'alethe-e2e-fixture-'))
  return {
    path,
    cleanup: () => {
      try {
        git(path, ['worktree', 'prune'])
      } catch {
        // best-effort — the folder will be removed anyway below.
      }
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
      } catch {
        // best-effort — test fixture cleanup, shouldn't hang the suite.
      }
    },
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Low-level setup via raw `git` (Node `child_process`, NEVER via Alethe)
 * — used only to prepare the initial state that the test isn't verifying
 * (e.g. giving the repo an initial commit on `main` before testing the merge
 * pipeline). Deliberately outside the tested path: if this used the same
 * commands as Alethe, a bug there could mask the test's own
 * setup.
 */
export function initRepoWithInitialCommit(repoPath: string, defaultBranch = 'main'): void {
  git(repoPath, ['init', '--initial-branch', defaultBranch])
  git(repoPath, ['config', 'user.email', 'e2e@alethe.test'])
  git(repoPath, ['config', 'user.name', 'Alethe E2E'])
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: repoPath,
    encoding: 'utf8',
  })
}

/**
 * INDEPENDENT confirmation that a real `.git` exists — never through
 * any Alethe API. It's the counterpoint to "the app says it initialized";
 * here it's the filesystem that decides.
 */
export function hasRealGitDir(repoPath: string): boolean {
  return existsSync(join(repoPath, '.git'))
}

/**
 * Direct commit (outside Alethe) on a specific branch, touching `filePath`
 * with `content` — used to force a real, deterministic conflict: the
 * test writes a concurrent change to the SAME line/file that the
 * agent's worktree also modified, instead of waiting for the agent to "randomly"
 * conflict.
 */
export function commitFileOnBranch(
  repoPath: string,
  branch: string,
  filePath: string,
  content: string,
  message: string,
): void {
  const currentBranch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (currentBranch !== branch) git(repoPath, ['checkout', branch])
  writeFileSync(join(repoPath, filePath), content)
  git(repoPath, ['add', filePath])
  git(repoPath, ['commit', '-m', message])
}

/**
 * Independent post-merge verification: reads `git log`/`git show` DIRECTLY on the
 * repository (never via Alethe) and confirms the expected content really is
 * in the target branch's HEAD — the assertion that replaces "trusting
 * what the app says happened".
 */
export function fileContentAtBranchHead(
  repoPath: string,
  branch: string,
  filePath: string,
): string | null {
  try {
    return git(repoPath, ['show', `${branch}:${filePath}`])
  } catch {
    return null
  }
}

export function lastCommitSubjectOnBranch(repoPath: string, branch: string): string {
  return git(repoPath, ['log', '-1', '--format=%s', branch])
}

import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

/** Same closed set as `Outcome` in `src-tauri/src/obs.rs`, so the doctor and the logs agree. */
export type CheckOutcome = 'ok' | 'rejected' | 'deferred' | 'failed' | 'skipped'

export type CheckResult = {
  /** Stable dotted id; later checks name it when they declare a dependency. */
  id: string
  title: string
  outcome: CheckOutcome
  /** Machine-readable verdict, never prose. */
  because: string
  evidence: Record<string, string>
  /** What to do about it, or null when there is nothing to do. */
  remedy: string | null
  /** The module the checked logic lives in, so a verdict points at code. */
  location: string
  elapsedMs: number
}

/**
 * Runs the local diagnosis.
 *
 * Never rejects on a failing check: a check that fails is a successful diagnosis, and treating it
 * as an error would make "the doctor could not run" and "the doctor found a problem" the same
 * observation — exactly the confusion these checks exist to end.
 */
export async function runSelfTest(): Promise<CheckResult[]> {
  if (isTauriEnv()) return invoke<CheckResult[]>('self_test')
  return webApiFetch<CheckResult[]>('/api/self-test')
}

import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

/** Event-bus type published when a project's change has both accumulated and settled. Must match
 *  `CHANGE_TRIGGER_EVENT` in `src-tauri/src/change_trigger.rs`. */
export const CHANGE_TRIGGER_EVENT = 'ChangeTriggerFired'

export type ChangeTriggerConfig = {
  /** Distinct files that must change before the trigger is eligible to fire. */
  fileThreshold: number
  /** How long the project must be untouched before firing. */
  quietPeriodMs: number
}

export type ChangeTriggerPayload = {
  projectId: string
  fileCount: number
  /** A sample of the changed paths, capped by the backend so a large refactor cannot produce an
   *  unbounded event. The popup reads the full picture from the working tree instead. */
  samplePaths: string[]
}

/** Starts watching a project's source for change worth describing. Resolves `false` when the
 *  platform could not provide a watcher at all — distinct from "started, nothing changed yet",
 *  which a caller has to be able to tell apart. */
export async function changeTriggerStart(
  projectId: string,
  projectRoot: string,
  config?: ChangeTriggerConfig,
): Promise<boolean> {
  if (isTauriEnv())
    return invoke<boolean>('change_trigger_start', { projectId, projectRoot, config })
  return webApiFetch<boolean>('/api/change_trigger/start', {
    method: 'POST',
    body: JSON.stringify({ projectId, projectRoot, config }),
  })
}

export async function changeTriggerStop(projectId: string): Promise<void> {
  if (isTauriEnv()) return invoke('change_trigger_stop', { projectId })
  await webApiFetch('/api/change_trigger/stop', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

/** Clears what has accumulated. Called both when the user sends the prompt (the procedure now
 *  covers this work) and when they dismiss it (they were asked once; asking again about the same
 *  batch would be nagging). */
export async function changeTriggerAcknowledge(projectId: string): Promise<void> {
  if (isTauriEnv()) return invoke('change_trigger_acknowledge', { projectId })
  await webApiFetch('/api/change_trigger/acknowledge', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

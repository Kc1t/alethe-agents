import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type AccessRecord = {
  id: string
  category: 'security' | 'collaboration'
  kind:
    | 'remote_invitation'
    | 'connection_candidate'
    | 'revocation'
    | 'provider_attention'
    | 'device_pending_approval'
    | 'invitation_redeemed'
    | 'sync_conflict'
    | 'task_assigned'
    | 'chat_mention'
    | 'transfer_failure'
    | 'pairing_request_pending'
  subjectHandle: string
  actionHandle: string
  unread: boolean
  dismissedAtMs: number | null
  deferredUntilMs: number | null
  createdAtMs: number
  updatedAtMs: number
}

export async function syncAccessList(): Promise<AccessRecord[]> {
  if (isTauriEnv()) return invoke('sync_access_list')
  return webApiFetch('/api/sync/access')
}

export async function syncAccessUpdate(
  id: string,
  operation: 'read' | 'dismiss' | 'defer',
  deferUntilMs?: number,
): Promise<AccessRecord> {
  if (isTauriEnv()) return invoke('sync_access_update', { id, operation, deferUntilMs })
  return webApiFetch('/api/sync/access/update', {
    method: 'POST',
    body: JSON.stringify({ id, operation, deferUntilMs }),
  })
}

/** Same operation as `syncAccessUpdate`, applied to every id in one backend round-trip (a single
 * load+mutate+save cycle) instead of N. Use this for a grouped row's action (e.g. dismissing "You
 * were mentioned in chat ×50" at once) — firing `syncAccessUpdate` once per id via `Promise.all`
 * queued N concurrent full-document rewrites of the same file and froze the app for a few seconds
 * on a large group (reported live). */
export async function syncAccessUpdateMany(
  ids: string[],
  operation: 'read' | 'dismiss' | 'defer',
  deferUntilMs?: number,
): Promise<AccessRecord[]> {
  if (isTauriEnv()) return invoke('sync_access_update_many', { ids, operation, deferUntilMs })
  return webApiFetch('/api/sync/access/update-many', {
    method: 'POST',
    body: JSON.stringify({ ids, operation, deferUntilMs }),
  })
}

export async function syncAccessResolveAction(actionHandle: string): Promise<AccessRecord> {
  if (isTauriEnv()) return invoke('sync_access_resolve_action', { actionHandle })
  return webApiFetch('/api/sync/access/action', {
    method: 'POST',
    body: JSON.stringify({ actionHandle }),
  })
}

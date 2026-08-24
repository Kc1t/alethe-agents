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

export async function syncAccessResolveAction(actionHandle: string): Promise<AccessRecord> {
  if (isTauriEnv()) return invoke('sync_access_resolve_action', { actionHandle })
  return webApiFetch('/api/sync/access/action', {
    method: 'POST',
    body: JSON.stringify({ actionHandle }),
  })
}

import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type CollaborationServiceMode = 'local_only' | 'alethe_managed' | 'advanced_custom'
export type CollaborationActivationState =
  | 'disabled'
  | 'identity_required'
  | 'ready'
  | 'connecting'
  | 'online'
  | 'retrying'
  | 'direct_only'
  | 'needs_attention'

export type CollaborationServiceSettings = {
  mode: CollaborationServiceMode
  enabled: boolean
  customEndpoint: string | null
  validatedEndpoint: string | null
  compatibleProtocolMin: number | null
  compatibleProtocolMax: number | null
  updatedAtMs: number
}

export type RendezvousStatus = {
  state:
    | 'no_attempt_yet'
    | 'connecting'
    | 'online'
    | 'retrying_after_transient_failure'
    | 'direct_session_only'
    | 'provider_failure'
  queuedEvents: number
  endpointConfigured: boolean
}

export async function getCollaborationServiceSettings(): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_get_activation_settings')
  return webApiFetch('/api/sync/activation')
}

export async function setCollaborationServiceMode(
  mode: CollaborationServiceMode,
  customEndpoint?: string,
): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_set_activation_mode', { mode, customEndpoint })
  return webApiFetch('/api/sync/activation/mode', {
    method: 'POST',
    body: JSON.stringify({ mode, customEndpoint }),
  })
}

export async function enableCollaborationService(): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_enable_activation')
  return webApiFetch('/api/sync/activation/enable', { method: 'POST' })
}

export async function disableCollaborationService(): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_disable_activation')
  return webApiFetch('/api/sync/activation/disable', { method: 'POST' })
}

export async function resolveCollaborationActivationState(): Promise<CollaborationActivationState> {
  if (isTauriEnv()) return invoke('sync_resolve_activation_state')
  return webApiFetch('/api/sync/activation/state')
}

export async function validateRendezvousEndpoint(endpoint: string): Promise<void> {
  if (isTauriEnv()) return invoke('sync_rendezvous_validate_endpoint', { endpoint })
  return webApiFetch('/api/sync/rendezvous/validate', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  })
}

export async function connectRendezvous(): Promise<RendezvousStatus> {
  if (isTauriEnv()) return invoke('sync_rendezvous_connect')
  return webApiFetch('/api/sync/rendezvous/connect', { method: 'POST' })
}

export async function disconnectRendezvous(): Promise<void> {
  if (isTauriEnv()) return invoke('sync_rendezvous_disconnect')
  return webApiFetch('/api/sync/rendezvous/disconnect', { method: 'POST' })
}

export async function getRendezvousStatus(): Promise<RendezvousStatus> {
  if (isTauriEnv()) return invoke('sync_rendezvous_status')
  return webApiFetch('/api/sync/rendezvous/status')
}

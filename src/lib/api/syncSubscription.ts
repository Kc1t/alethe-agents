import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type SubscriptionState =
  | 'offered'
  | 'configuring'
  | 'awaiting_confirmation'
  | 'staging'
  | 'verifying'
  | 'active'
  | 'deferred'
  | 'declined'
  | 'paused'
  | 'revoked'
  | 'error'
  | 'removing'

export type SubscriptionMode = 'manual_snapshot' | 'receive_after_confirmation' | 'bidirectional'

export type SubscriptionRecord = {
  subscriptionId: string
  projectId: string
  grantId: string
  deviceId: string
  destination: string | null
  mode: SubscriptionMode | null
  state: SubscriptionState
  exclusionPolicyVersion: number
  remoteManifestRevision: string | null
  createdAtMs: number
  updatedAtMs: number
  errorCode: string | null
}

export async function syncListSubscriptions(): Promise<SubscriptionRecord[]> {
  if (isTauriEnv()) return invoke<SubscriptionRecord[]>('sync_list_subscriptions')
  return webApiFetch<SubscriptionRecord[]>('/api/sync/subscriptions')
}

export async function syncOfferSubscription(
  projectId: string,
  grantId: string,
  deviceId: string,
): Promise<SubscriptionRecord> {
  if (isTauriEnv()) {
    return invoke<SubscriptionRecord>('sync_offer_subscription', {
      projectId,
      grantId,
      deviceId,
    })
  }
  return webApiFetch<SubscriptionRecord>('/api/sync/subscriptions/offer', {
    method: 'POST',
    body: JSON.stringify({ projectId, grantId, deviceId }),
  })
}

export async function syncConfigureSubscriptionDestination(
  subscriptionId: string,
  destination: string,
): Promise<SubscriptionRecord> {
  if (isTauriEnv()) {
    return invoke<SubscriptionRecord>('sync_configure_subscription_destination', {
      subscriptionId,
      destination,
    })
  }
  return webApiFetch<SubscriptionRecord>('/api/sync/subscriptions/destination', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, destination }),
  })
}

export async function syncSelectSubscriptionMode(
  subscriptionId: string,
  mode: SubscriptionMode,
): Promise<SubscriptionRecord> {
  if (isTauriEnv()) {
    return invoke<SubscriptionRecord>('sync_select_subscription_mode', { subscriptionId, mode })
  }
  return webApiFetch<SubscriptionRecord>('/api/sync/subscriptions/mode', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId, mode }),
  })
}

export async function syncConfirmSubscription(subscriptionId: string): Promise<SubscriptionRecord> {
  if (isTauriEnv()) {
    return invoke<SubscriptionRecord>('sync_confirm_subscription', { subscriptionId })
  }
  return webApiFetch<SubscriptionRecord>('/api/sync/subscriptions/confirm', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId }),
  })
}

export async function syncDeferSubscription(subscriptionId: string): Promise<SubscriptionRecord> {
  if (isTauriEnv()) {
    return invoke<SubscriptionRecord>('sync_defer_subscription', { subscriptionId })
  }
  return webApiFetch<SubscriptionRecord>('/api/sync/subscriptions/defer', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId }),
  })
}

export async function syncDeclineSubscription(subscriptionId: string): Promise<SubscriptionRecord> {
  if (isTauriEnv()) {
    return invoke<SubscriptionRecord>('sync_decline_subscription', { subscriptionId })
  }
  return webApiFetch<SubscriptionRecord>('/api/sync/subscriptions/decline', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId }),
  })
}

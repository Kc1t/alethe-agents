import { invoke } from '@tauri-apps/api/core'

export type CloudPlan = 'free' | 'supporter'

export type CloudSyncStatus = {
  connected: boolean
  login: string | null
  name: string | null
  avatar_url: string | null
  plan: CloudPlan | null
  device_id: string | null
}

export type CloudDeviceStart = {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

export type CloudDeviceRef = { id: string; name: string | null }

export type CloudManifest = {
  profile: string
  scopes: Partial<
    Record<string, { version: number; updatedAt: number; updatedBy: CloudDeviceRef | null }>
  >
}

export type CloudDoc = {
  payload: unknown
  version: number
  updatedAt: number | null
  updatedBy: CloudDeviceRef | null
}

export type CloudPutOutcome =
  { kind: 'ok'; version: number } | { kind: 'conflict'; remote: CloudDoc }

export type CloudLimits = {
  scopes: string[]
  maxScopeBytes: number
  writesPerHour: number
  revisionsKept: number
  profiles: number
}

export type CloudAccount = {
  user: { login: string; name: string | null; avatarUrl: string | null }
  deviceId: string
  plan: CloudPlan
  entitlement: { source: string; status: string; currentPeriodEnd: number | null } | null
  limits: CloudLimits
}

export type CloudDevice = {
  id: string
  name: string
  platform: string
  appVersion: string | null
  createdAt: number
  lastSeenAt: number
  current: boolean
}

export type CloudRevision = {
  version: number
  createdAt: number
  size: number
  device: CloudDeviceRef | null
}

export async function cloudSyncStatus(): Promise<CloudSyncStatus> {
  return invoke<CloudSyncStatus>('cloud_sync_status')
}

export async function cloudSyncDeviceStart(): Promise<CloudDeviceStart> {
  return invoke<CloudDeviceStart>('cloud_sync_device_start')
}

export async function cloudSyncDeviceFinish(start: CloudDeviceStart): Promise<CloudSyncStatus> {
  return invoke<CloudSyncStatus>('cloud_sync_device_finish', {
    deviceCode: start.device_code,
    interval: start.interval,
    expiresIn: start.expires_in,
  })
}

export async function cloudSyncLogout(): Promise<CloudSyncStatus> {
  return invoke<CloudSyncStatus>('cloud_sync_logout')
}

export async function cloudSyncMe(): Promise<CloudAccount> {
  return invoke<CloudAccount>('cloud_sync_me')
}

export async function cloudSyncManifest(): Promise<CloudManifest> {
  return invoke<CloudManifest>('cloud_sync_manifest')
}

export async function cloudSyncGet(scope: string): Promise<CloudDoc | null> {
  return invoke<CloudDoc | null>('cloud_sync_get', { scope })
}

export async function cloudSyncPut(
  scope: string,
  payload: unknown,
  baseVersion: number,
): Promise<CloudPutOutcome> {
  return invoke<CloudPutOutcome>('cloud_sync_put', { scope, payload, baseVersion })
}

export async function cloudSyncRevisions(scope: string): Promise<CloudRevision[]> {
  const body = await invoke<{ revisions: CloudRevision[] }>('cloud_sync_revisions', { scope })
  return body.revisions
}

export async function cloudSyncRevision(scope: string, version: number): Promise<CloudDoc> {
  return invoke<CloudDoc>('cloud_sync_revision', { scope, version })
}

export async function cloudSyncDevices(): Promise<CloudDevice[]> {
  const body = await invoke<{ devices: CloudDevice[] }>('cloud_sync_devices')
  return body.devices
}

export async function cloudSyncRevokeDevice(deviceId: string): Promise<void> {
  await invoke('cloud_sync_revoke_device', { deviceId })
}

export async function cloudSyncDeleteAccount(): Promise<CloudSyncStatus> {
  return invoke<CloudSyncStatus>('cloud_sync_delete_account')
}

export async function cloudSyncExportAccount(targetPath: string): Promise<void> {
  await invoke('cloud_sync_export_account', { targetPath })
}

export async function cloudBillingCheckout(interval: 'month' | 'year'): Promise<string> {
  return invoke<string>('cloud_billing_checkout', { interval })
}

export async function cloudBillingPortal(): Promise<string> {
  return invoke<string>('cloud_billing_portal')
}

export async function cloudBillingRefresh(): Promise<{ plan: CloudPlan }> {
  return invoke<{ plan: CloudPlan }>('cloud_billing_refresh')
}

export async function cloudSyncStateRead(): Promise<unknown> {
  return invoke<unknown>('cloud_sync_state_read')
}

export async function cloudSyncStateWrite(state: unknown): Promise<void> {
  await invoke('cloud_sync_state_write', { state })
}

export type CloudMachine = { id: string; name: string }

export async function cloudSyncMachine(): Promise<CloudMachine> {
  return invoke<CloudMachine>('cloud_sync_machine')
}

export async function gitRemoteOrigin(path: string): Promise<string | null> {
  return invoke<string | null>('git_remote_origin', { path })
}

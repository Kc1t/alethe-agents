import { invoke } from '@tauri-apps/api/core'

import { canUseSharedCoreTransport, isTauriEnv, webApiFetch } from './transport'

export type ProfileMeta = {
  id: string
  name: string
  created_at_ms: number
  last_used_at_ms: number
}

export type ProfilesState = {
  active_profile_id: string
  profiles: ProfileMeta[]
}

export type ProfileSummary = {
  id: string
  name: string
  profile_image_url: string
  created_at_ms: number
  last_used_at_ms: number
  project_count: number
  terminal_count: number
  is_active: boolean
}

export async function listProfiles(): Promise<ProfilesState> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProfilesState>('list_profiles')
  }
  return webApiFetch<ProfilesState>('/api/profiles/list')
}

export async function listProfileSummaries(): Promise<ProfileSummary[]> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProfileSummary[]>('list_profile_summaries')
  }
  return webApiFetch<ProfileSummary[]>('/api/profiles/summaries')
}

export async function getActiveProfile(): Promise<ProfileMeta> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProfileMeta>('get_active_profile')
  }
  return webApiFetch<ProfileMeta>('/api/profiles/active')
}

export async function setActiveProfile(profileId: string): Promise<ProfilesState> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProfilesState>('set_active_profile', { profileId })
  }
  return webApiFetch<ProfilesState>('/api/profiles/set_active', {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  })
}

export async function createProfile(name?: string): Promise<ProfilesState> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProfilesState>('create_profile', { name })
  }
  return webApiFetch<ProfilesState>('/api/profiles/create', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function renameProfile(profileId: string, name: string): Promise<ProfilesState> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProfilesState>('rename_profile', { profileId, name })
  }
  return webApiFetch<ProfilesState>('/api/profiles/rename', {
    method: 'POST',
    body: JSON.stringify({ profileId, name }),
  })
}

export async function deleteProfile(profileId: string): Promise<ProfilesState> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProfilesState>('delete_profile', { profileId })
  }
  return webApiFetch<ProfilesState>('/api/profiles/delete', {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  })
}

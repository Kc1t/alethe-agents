import defaultProfileImage from '../assets/theme-icons/dark.png'
import type { Preferences } from './types'

export const DEFAULT_PROFILE_IMAGE_URL = defaultProfileImage

type ProfileAccountNameInput = {
  profileId: string
  profileName: string
  activeProfileId: string
  displayName: string
}

export function getProfileAccountName({
  profileId,
  profileName,
  activeProfileId,
  displayName,
}: ProfileAccountNameInput): string {
  const activeDisplayName = displayName.trim()
  const isDefaultPlaceholder = profileId === 'default' && profileName === 'Default'
  return profileId === activeProfileId && isDefaultPlaceholder && activeDisplayName
    ? activeDisplayName
    : profileName
}

export function getProfileImageUrl(preferences: Preferences): string | null {
  const url = preferences.profileImageUrl.trim()
  return url.length > 0 ? url : DEFAULT_PROFILE_IMAGE_URL
}

export function getProfileInitial(displayName: string): string {
  return displayName.trim().charAt(0).toUpperCase() || '?'
}

export function getFirstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || 'amigo'
}

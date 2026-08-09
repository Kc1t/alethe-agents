import type { Preferences } from './types'
import defaultProfileImage from '../assets/theme-icons/dark.png'

export const DEFAULT_PROFILE_IMAGE_URL = defaultProfileImage

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

import type { McpCatalogEntry } from '../../../lib/tauri'

export type RegistryReview = {
  origin: string
  title: string
  version: string
  repositoryUrl: string | null
  acknowledged: boolean
}

export type RegistryReviewAction =
  | { type: 'select'; entry: McpCatalogEntry }
  | { type: 'acknowledge'; value: boolean }
  | { type: 'reset' }

export function registryReviewReducer(
  state: RegistryReview | null,
  action: RegistryReviewAction,
): RegistryReview | null {
  switch (action.type) {
    case 'select':
      return {
        origin: action.entry.id,
        title: action.entry.title,
        version: action.entry.version,
        repositoryUrl: action.entry.repositoryUrl,
        acknowledged: false,
      }
    case 'acknowledge':
      return state ? { ...state, acknowledged: action.value } : null
    case 'reset':
      return null
  }
}

export function registryReviewAllowsSubmit(review: RegistryReview | null): boolean {
  return review === null || review.acknowledged
}

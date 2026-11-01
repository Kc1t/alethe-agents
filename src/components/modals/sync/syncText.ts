import { intlLocale, type Locale, type MessageKey, type TFunction } from '../../../lib/i18n'
import type { summarizeResult } from '../../../lib/sync'

const KNOWN_ERRORS = new Set([
  'not_connected',
  'session_expired',
  'access_denied',
  'code_expired',
  'malformed_payload',
  'plan_required',
  'payload_too_large',
  'rate_limited',
  'client_outdated',
  'billing_unavailable',
  'no_customer',
  'invalid_bundle',
  'conflict_retry_exhausted',
  'profile_limit',
  'no_remote',
  'remote_missing_projects',
])

export function syncErrorText(t: TFunction, raw: unknown): string {
  const message =
    typeof raw === 'string' ? raw : String((raw as { message?: string })?.message ?? raw)
  if (message.startsWith('secure_store_unavailable'))
    return t('sync.error.secure_store_unavailable')
  if (KNOWN_ERRORS.has(message)) return t(`sync.error.${message}` as MessageKey)
  return t('sync.error.generic', { error: message })
}

export function formatWhen(t: TFunction, locale: Locale, ms: number | null | undefined): string {
  if (!ms) return t('sync.github.never')
  try {
    return new Date(ms).toLocaleString(intlLocale(locale))
  } catch {
    return new Date(ms).toLocaleString()
  }
}

export function summaryText(t: TFunction, summary: ReturnType<typeof summarizeResult>): string {
  const parts: string[] = []
  if (summary.updated) parts.push(t('sync.summary.updated', { count: summary.updated }))
  if (summary.available) parts.push(t('sync.summary.available', { count: summary.available }))
  if (summary.preferences) parts.push(t('sync.summary.preferences', { count: summary.preferences }))
  if (summary.tooling) parts.push(t('sync.summary.tooling', { count: summary.tooling }))
  if (parts.length === 0) {
    return summary.pushed ? t('sync.summary.pushed') : t('sync.cloud.upToDate')
  }
  return parts.join(' · ')
}

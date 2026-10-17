import type { MessageKey } from '../i18n/messages/en'

export const SERVER_ERROR_CODES = [
  'policy',
  'invalidUrl',
  'network',
  'timeout',
  'auth',
  'badRequest',
  'badAudio',
  'missing',
  'invalidName',
  'invalidModel',
  'invalidKey',
  'limit',
  'other',
] as const
type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number]

/** The message for a backend `voice_server_*` code (or a bare kind); unknown reads as `other`. */
export function serverErrorKey(error: unknown): MessageKey {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = raw.replace(/^voice_server_/, '')
  const known = (SERVER_ERROR_CODES as readonly string[]).includes(code)
  return `prefs.voiceServerError.${(known ? code : 'other') as ServerErrorCode}`
}

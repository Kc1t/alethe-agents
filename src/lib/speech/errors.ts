/** The code Rust ends a recording too short to transcribe with (usually a quick tap). */
const TOO_SHORT = 'speech_too_short'

export function isSpeechTooShort(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return text === TOO_SHORT
}

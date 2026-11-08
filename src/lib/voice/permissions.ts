import type { VoiceApprovalChannel } from './hudState'

export type PermissionAnswer =
  { kind: 'allow' } | { kind: 'deny'; message?: string } | { kind: 'defer' }

export function answerAllowed(
  answer: PermissionAnswer,
  destructive: boolean,
  options: { channel: VoiceApprovalChannel; destructiveNeedsHud: boolean },
  source: 'voice' | 'hud',
): boolean {
  if (answer.kind === 'defer') return true
  const guarded = destructive && options.destructiveNeedsHud
  if (source === 'voice') {
    if (options.channel === 'hud') return false
    return !(guarded && answer.kind === 'allow')
  }
  return options.channel !== 'voice' || guarded
}

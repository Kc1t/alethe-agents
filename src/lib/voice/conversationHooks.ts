const holders = new Set<string>()

export function holdVoiceConversationHooks(holder: string, enabled: boolean): void {
  if (enabled) holders.add(holder)
  else holders.delete(holder)
}

export function voiceConversationHooksEnabled(): boolean {
  return holders.size > 0
}

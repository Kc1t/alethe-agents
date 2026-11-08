let holds = 0

export function suspendKeybindings(): () => void {
  holds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
  }
}

export function keybindingsSuspended(): boolean {
  return holds > 0
}

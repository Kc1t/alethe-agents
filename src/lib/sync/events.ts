type Listener = () => void

const listeners = new Set<Listener>()

export function notifyCloudStatusChanged(): void {
  for (const listener of listeners) listener()
}

export function onCloudStatusChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

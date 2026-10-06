import { customAgentIconDataUrl, importCustomAgentIcon, removeCustomAgentIcon } from './tauri'

const fileSrcCache = new Map<string, string>()

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isCustomIconFileAvailable(): boolean {
  return isTauriEnv()
}

export async function importCustomAgentIconAsset(
  sourcePath: string,
  agentId: string,
): Promise<void> {
  await importCustomAgentIcon(sourcePath, agentId)
  fileSrcCache.delete(agentId)
}

export async function customAgentIconFileSrc(assetId: string): Promise<string | null> {
  const cached = fileSrcCache.get(assetId)
  if (cached) return cached
  if (!isTauriEnv()) return null
  try {
    const src = await customAgentIconDataUrl(assetId)
    fileSrcCache.set(assetId, src)
    return src
  } catch {
    return null
  }
}

export function invalidateCustomAgentIconAsset(assetId: string): void {
  fileSrcCache.delete(assetId)
}

export async function removeCustomAgentIconAsset(assetId: string): Promise<void> {
  fileSrcCache.delete(assetId)
  if (!isTauriEnv()) return
  await removeCustomAgentIcon(assetId)
}

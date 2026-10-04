import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'

import { allowAssetPreview } from './tauri'

const allowed = new Map<string, Promise<string>>()

/**
 * A URL the webview can load a local media file from. The asset protocol serves nothing until the
 * backend allows a file, so each path is allowed once and the answer is shared by every preview of
 * it. A refusal is not kept, so a file that appears later can still be shown.
 */
export function mediaUrl(path: string): Promise<string> {
  let pending = allowed.get(path)
  if (!pending) {
    pending = allowAssetPreview(path).then((resolved) => convertFileSrc(resolved))
    allowed.set(path, pending)
    pending.catch(() => allowed.delete(path))
  }
  return pending
}

/** `mediaUrl` for a component: undefined until the file is allowed, or when there is no path. */
export function useMediaUrl(path: string | null | undefined): string | undefined {
  const [resolved, setResolved] = useState<{ path: string; url: string } | null>(null)

  useEffect(() => {
    if (!path) return
    let active = true
    mediaUrl(path)
      .then((url) => {
        if (active) setResolved({ path, url })
      })
      .catch((error) => console.warn('[media] preview refused for', path, error))
    return () => {
      active = false
    }
  }, [path])

  return path && resolved?.path === path ? resolved.url : undefined
}

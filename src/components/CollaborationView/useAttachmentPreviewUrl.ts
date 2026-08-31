import { useEffect, useState } from 'react'

import { syncDownloadAttachment } from '../../lib/api/syncChat'
import { guessMimeFromName, previewKindFor } from '../../lib/attachmentReference'

/** Per-attachment object URL cache, shared across every place that previews the same attachment
 * (a single preview, a grid tile, re-renders on scroll) — must not re-download and re-decrypt the
 * same bytes every time something using it re-renders. Never explicitly revoked: these are small
 * (capped at `MAX_ATTACHMENT_BYTES`, 8MB) and live only as long as the app session anyway. */
const objectUrlCache = new Map<string, string>()

/** Caps how many attachment downloads+decrypts run at once, across every preview/grid tile in the
 * app. `useInView` already keeps most off-screen attachments from fetching at all, but a tall,
 * dense burst of image messages can still bring a few dozen into view (or its preload margin) at
 * the same moment a conversation first opens — each one is a full decrypt on the main thread, and
 * that many at once is exactly what froze the app and made the message list unscrollable. Only a
 * handful of them run in parallel; the rest wait their turn. */
const MAX_CONCURRENT_DOWNLOADS = 3
let activeDownloads = 0
const downloadQueue: (() => void)[] = []

function runQueued() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
    const next = downloadQueue.shift()!
    activeDownloads += 1
    next()
  }
}

function withDownloadSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    downloadQueue.push(() => {
      task()
        .then(resolve, reject)
        .finally(() => {
          activeDownloads -= 1
          runQueued()
        })
    })
    runQueued()
  })
}

/** Downloads+decrypts (via `syncDownloadAttachment`, on demand, once per attachment) and exposes
 * an object URL for an image/video attachment. `kind` is `null` for anything that isn't
 * previewable (the caller should show a generic file chip instead — this hook never fetches for
 * those, there's nothing to preview).
 *
 * `enabled` (default true) gates the actual download — pass `false` (e.g. from `useInView`) for
 * attachments that aren't visible yet. A conversation with many image messages would otherwise
 * fire a download+decrypt for every single one the instant the chat opens, saturating the main
 * thread and the P2P/relay channel at once (this is what made the whole app freeze and made the
 * message list unscrollable, since every render was competing with dozens of in-flight decrypts). */
export function useAttachmentPreviewUrl(conversationId: string, attachmentId: string, name: string, enabled = true) {
  const kind = previewKindFor(name)
  const [url, setUrl] = useState<string | null>(objectUrlCache.get(attachmentId) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled || !kind || url) return
    let active = true
    setFailed(false)
    void withDownloadSlot(() => syncDownloadAttachment(conversationId, attachmentId))
      .then((bytes) => {
        if (!active) return
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: guessMimeFromName(name) })
        const objectUrl = URL.createObjectURL(blob)
        objectUrlCache.set(attachmentId, objectUrl)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [conversationId, attachmentId, kind, url, name, enabled])

  return { kind, url, failed }
}

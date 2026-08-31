import { useEffect, useState } from 'react'

import { syncDownloadAttachment } from '../../lib/api/syncChat'
import { guessMimeFromName, previewKindFor } from '../../lib/attachmentReference'

/** Per-attachment object URL cache, shared across every place that previews the same attachment
 * (a single preview, a grid tile, re-renders on scroll) — must not re-download and re-decrypt the
 * same bytes every time something using it re-renders. Never explicitly revoked: these are small
 * (capped at `MAX_ATTACHMENT_BYTES`, 8MB) and live only as long as the app session anyway. */
const objectUrlCache = new Map<string, string>()

/** Downloads+decrypts (via `syncDownloadAttachment`, on demand, once per attachment) and exposes
 * an object URL for an image/video attachment. `kind` is `null` for anything that isn't
 * previewable (the caller should show a generic file chip instead — this hook never fetches for
 * those, there's nothing to preview). */
export function useAttachmentPreviewUrl(conversationId: string, attachmentId: string, name: string) {
  const kind = previewKindFor(name)
  const [url, setUrl] = useState<string | null>(objectUrlCache.get(attachmentId) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!kind || url) return
    let active = true
    setFailed(false)
    void syncDownloadAttachment(conversationId, attachmentId)
      .then((bytes) => {
        if (!active) return
        const blob = new Blob([new Uint8Array(bytes)], { type: guessMimeFromName(name) })
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
  }, [conversationId, attachmentId, kind, url, name])

  return { kind, url, failed }
}

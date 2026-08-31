import { Download, File as FileIcon, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { syncDownloadAttachment } from '../../lib/api/syncChat'
import { guessMimeFromName, previewKindFor } from '../../lib/attachmentReference'
import { useT } from '../../lib/i18n'
import styles from './AttachmentPreview.module.css'
import { Lightbox } from './Lightbox'

/** Per-attachment object URL cache, shared across every message row that references the same
 * attachment (re-rendering the message list — e.g. on scroll — must not re-download and
 * re-decrypt the same bytes every time). Never explicitly revoked: these are small (capped at
 * `MAX_ATTACHMENT_BYTES`, 8MB) and live only as long as the chat panel/app session anyway. */
const objectUrlCache = new Map<string, string>()

/** Renders an inline image/video preview for a chat attachment (decrypted on demand via
 * `syncDownloadAttachment`), or a clickable "download" file chip for anything else — instead of
 * the plain "Shared a file: name.png (id ...)" text every attachment message used to show
 * regardless of what it actually was. Clicking an image/video preview opens it full-screen (see
 * `Lightbox` below) — the inline thumbnail is deliberately small (fits the message bubble), so
 * there has to be a way to actually see the thing at size. */
export function AttachmentPreview({
  conversationId,
  attachmentId,
  name,
  caption,
}: {
  conversationId: string
  attachmentId: string
  name: string
  /** Text the sender typed alongside the attachment, if any — shown below the preview. */
  caption?: string
}) {
  const t = useT()
  const kind = previewKindFor(name)
  const [url, setUrl] = useState<string | null>(objectUrlCache.get(attachmentId) ?? null)
  const [failed, setFailed] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

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

  const downloadToDisk = async () => {
    setDownloading(true)
    try {
      const bytes = await syncDownloadAttachment(conversationId, attachmentId)
      const blob = new Blob([new Uint8Array(bytes)], { type: guessMimeFromName(name) })
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = name
      link.click()
      URL.revokeObjectURL(objectUrl)
    } catch {
      setFailed(true)
    } finally {
      setDownloading(false)
    }
  }

  if (!kind || failed) {
    return (
      <button type="button" className={styles.fileChip} onClick={() => void downloadToDisk()} disabled={downloading}>
        {downloading ? <Loader2 size={14} className={styles.spin} /> : <FileIcon size={14} />}
        <span className={styles.fileName}>{name}</span>
        {!downloading ? <Download size={12} className={styles.downloadIcon} /> : null}
        {failed ? <span className={styles.fileError}>{t('chat.attachmentPreviewFailed')}</span> : null}
      </button>
    )
  }

  if (!url) {
    return (
      <div className={styles.loadingPreview}>
        <Loader2 size={16} className={styles.spin} />
      </div>
    )
  }

  return (
    <div className={styles.previewWrap}>
      {kind === 'image' ? (
        <img
          src={url}
          alt={name}
          className={styles.imagePreview}
          draggable={false}
          onClick={() => setLightboxOpen(true)}
        />
      ) : (
        // A click anywhere except the native controls strip opens the lightbox — `<video>`'s own
        // controls need their clicks to reach the element, so this can't just be a wrapping button.
        <video src={url} controls className={styles.videoPreview} onClick={() => setLightboxOpen(true)} />
      )}
      {caption ? <p className={styles.caption}>{caption}</p> : null}
      {lightboxOpen ? <Lightbox src={url} kind={kind} alt={name} onClose={() => setLightboxOpen(false)} /> : null}
    </div>
  )
}

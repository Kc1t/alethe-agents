import { Download, File as FileIcon, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { syncDownloadAttachment } from '../../lib/api/syncChat'
import { guessMimeFromName } from '../../lib/attachmentReference'
import { useT } from '../../lib/i18n'
import styles from './AttachmentPreview.module.css'
import { useInView } from './useInView'
import { Lightbox } from './Lightbox'
import { useAttachmentPreviewUrl } from './useAttachmentPreviewUrl'

/** Renders an inline image/video preview for a chat attachment (decrypted on demand via
 * `syncDownloadAttachment`), or a clickable "download" file chip for anything else — instead of
 * the plain "Shared a file: name.png (id ...)" text every attachment message used to show
 * regardless of what it actually was. Clicking an image/video preview opens it full-screen (see
 * `Lightbox`) — the inline thumbnail is deliberately small (fits the message bubble), so there
 * has to be a way to actually see the thing at size. */
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
  const { ref: inViewRef, inView } = useInView<HTMLDivElement>()
  const { kind, url, failed } = useAttachmentPreviewUrl(conversationId, attachmentId, name, inView)
  const [downloading, setDownloading] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const downloadToDisk = async () => {
    setDownloading(true)
    try {
      const bytes = await syncDownloadAttachment(conversationId, attachmentId)
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: guessMimeFromName(name) })
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = name
      link.click()
      URL.revokeObjectURL(objectUrl)
    } catch {
      // downloadToDisk failing doesn't affect the preview's own `failed` state — this is a
      // separate action (a save-to-disk request), not part of loading the inline preview.
      console.error('[chat] attachment download to disk failed')
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
      <div ref={inViewRef} className={styles.loadingPreview}>
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
      {lightboxOpen ? (
        <Lightbox items={[{ src: url, kind, alt: name }]} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </div>
  )
}

import { File as FileIcon, Loader2 } from 'lucide-react'
import { useState } from 'react'

import type { AttachmentReference } from '../../lib/attachmentReference'
import styles from './AttachmentGrid.module.css'
import { Lightbox, type LightboxItem } from './Lightbox'
import { useAttachmentPreviewUrl } from './useAttachmentPreviewUrl'

const VISIBLE_TILE_COUNT = 4

/** One tile in the grid — resolves its own preview URL (same cache as `AttachmentPreview`, so a
 * file already shown elsewhere in the conversation doesn't re-download). `overlayCount` renders
 * the WhatsApp-style "+N" dimmed overlay on the last visible tile when the group has more items
 * than fit in the grid. */
function GridTile({
  conversationId,
  attachment,
  onOpen,
  overlayCount,
}: {
  conversationId: string
  attachment: AttachmentReference
  onOpen: () => void
  overlayCount?: number
}) {
  const { kind, url } = useAttachmentPreviewUrl(conversationId, attachment.attachmentId, attachment.name)
  return (
    <button type="button" className={styles.tile} onClick={onOpen}>
      {kind === 'image' && url ? (
        <img src={url} alt={attachment.name} className={styles.tileMedia} draggable={false} />
      ) : kind === 'video' && url ? (
        <video src={url} className={styles.tileMedia} />
      ) : (kind === 'image' || kind === 'video') && !url ? (
        <div className={styles.tilePlaceholder}>
          <Loader2 size={18} className={styles.spin} />
        </div>
      ) : (
        <div className={styles.tilePlaceholder}>
          <FileIcon size={20} />
        </div>
      )}
      {overlayCount ? (
        <div className={styles.tileOverlay}>
          <span>+{overlayCount}</span>
        </div>
      ) : null}
    </button>
  )
}

/** Renders a WhatsApp-style 2×2 grid for a message carrying several attachments sent together as
 * one group — instead of the previous behavior of sending (and showing) one separate message per
 * file, cluttering the conversation with a run of near-identical "shared a file" bubbles. Only the
 * first 4 attachments get a visible tile; the 4th shows a "+N" overlay for the rest. Clicking any
 * tile opens the full-screen gallery viewer (`Lightbox`) at that item, with prev/next + a
 * filmstrip to browse the whole group — not just the 4 shown here. */
export function AttachmentGrid({
  conversationId,
  attachments,
  caption,
}: {
  conversationId: string
  attachments: AttachmentReference[]
  caption?: string
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const visible = attachments.slice(0, VISIBLE_TILE_COUNT)
  const overflowCount = attachments.length - VISIBLE_TILE_COUNT

  return (
    <div className={styles.wrap}>
      <div className={`${styles.grid} ${visible.length === 1 ? styles.gridSingle : ''}`}>
        {visible.map((attachment, index) => (
          <GridTile
            key={attachment.attachmentId}
            conversationId={conversationId}
            attachment={attachment}
            onOpen={() => setLightboxIndex(index)}
            overlayCount={index === VISIBLE_TILE_COUNT - 1 && overflowCount > 0 ? overflowCount : undefined}
          />
        ))}
      </div>
      {caption ? <p className={styles.caption}>{caption}</p> : null}
      {lightboxIndex !== null ? (
        <AttachmentGridLightbox
          conversationId={conversationId}
          attachments={attachments}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </div>
  )
}

/** Resolves every attachment in the group to a preview URL before opening the gallery viewer —
 * `Lightbox` itself is a dumb viewer over a fixed `items` list (it doesn't know how to fetch
 * anything), so this is the glue that gives it real, already-decrypted URLs to browse. */
function AttachmentGridLightbox({
  conversationId,
  attachments,
  initialIndex,
  onClose,
}: {
  conversationId: string
  attachments: AttachmentReference[]
  initialIndex: number
  onClose: () => void
}) {
  const resolved = attachments.map((attachment) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- `attachments` is stable for the
    // lifetime of one message/group; this map runs the same fixed number of hooks every render.
    const { kind, url } = useAttachmentPreviewUrl(conversationId, attachment.attachmentId, attachment.name)
    return { kind, url, name: attachment.name }
  })
  const items: LightboxItem[] = resolved
    .filter((entry): entry is { kind: 'image' | 'video'; url: string; name: string } => entry.kind !== null && entry.url !== null)
    .map((entry) => ({ src: entry.url, kind: entry.kind, alt: entry.name }))
  if (items.length === 0) return null
  // Attachments that failed to resolve (non-previewable, or still loading) are simply absent from
  // `items` — clamp the requested index into whatever did resolve rather than crashing on an
  // out-of-range access.
  const clampedIndex = Math.min(initialIndex, items.length - 1)
  return <Lightbox items={items} initialIndex={clampedIndex} onClose={onClose} />
}

// A chat "attachment message" carries a machine-readable marker prefix, followed by the existing
// localized fallback text (`chat.attachmentMessage`) — so a client that doesn't understand the
// marker still shows something useful, and a client that does can render an actual preview
// instead of parsing locale-dependent prose (which `Shared a file: {name} (id {id})` was never
// meant to survive — different wording per locale, easy to break by editing a translation).

const ATTACHMENT_MARKER_PATTERN = /^⟦attachment:([^:⟧]+):([^⟧]*)⟧/

export function encodeAttachmentReference(attachmentId: string, name: string): string {
  return `⟦attachment:${attachmentId}:${name}⟧`
}

export function parseAttachmentReference(text: string): { attachmentId: string; name: string; rest: string } | null {
  const match = text.match(ATTACHMENT_MARKER_PATTERN)
  if (!match) return null
  return { attachmentId: match[1], name: match[2], rest: text.slice(match[0].length) }
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'])

/** Best-effort MIME guess from the filename — the only content-type signal available on the
 * receiving side today (the message text doesn't carry the sender's `declaredContentType`). Good
 * enough to decide "show an image/video preview or a generic file chip", not meant as an
 * authoritative content-type. */
export function guessMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTENSIONS.has(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`
  if (VIDEO_EXTENSIONS.has(ext)) return `video/${ext}`
  return 'application/octet-stream'
}

export function previewKindFor(name: string): 'image' | 'video' | null {
  const mime = guessMimeFromName(name)
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return null
}

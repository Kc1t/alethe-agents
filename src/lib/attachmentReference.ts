// A chat "attachment message" carries one or more machine-readable marker prefixes (one per
// attachment in the group — several files sent together are one message, not N), followed by the
// existing localized fallback text (`chat.attachmentMessage`) when there's no real caption — so a
// client that doesn't understand the marker still shows something useful, and one that does can
// render an actual preview/grid instead of parsing locale-dependent prose (which
// `Shared a file: {name} (id {id})` was never meant to survive — different wording per locale,
// easy to break by editing a translation).

export type AttachmentReference = { attachmentId: string; name: string }

const ATTACHMENT_MARKER_PATTERN = /⟦attachment:([^:⟧]+):([^⟧]*)⟧/g

export function encodeAttachmentReferences(attachments: AttachmentReference[]): string {
  return attachments
    .map((attachment) => `⟦attachment:${attachment.attachmentId}:${attachment.name}⟧`)
    .join('')
}

/** Parses every attachment marker at the start of a message's text (there may be more than one —
 * several files sent together as one group/message), returning them plus whatever text follows
 * the last marker (the caption, or the locale-generated fallback text if none was typed). `null`
 * if the message carries no attachment marker at all (an ordinary text message). */
export function parseAttachmentReferences(
  text: string,
): { attachments: AttachmentReference[]; rest: string } | null {
  const attachments: AttachmentReference[] = []
  let lastIndex = 0
  ATTACHMENT_MARKER_PATTERN.lastIndex = 0
  for (const match of text.matchAll(ATTACHMENT_MARKER_PATTERN)) {
    // Markers must be contiguous from the very start — anything else means this isn't actually an
    // attachment message (e.g. someone typed the marker glyphs themselves), so bail out entirely
    // rather than misinterpret ordinary text as a broken attachment reference.
    if (match.index !== lastIndex)
      return attachments.length > 0 ? { attachments, rest: text.slice(lastIndex) } : null
    attachments.push({ attachmentId: match[1], name: match[2] })
    lastIndex = match.index + match[0].length
  }
  if (attachments.length === 0) return null
  return { attachments, rest: text.slice(lastIndex) }
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

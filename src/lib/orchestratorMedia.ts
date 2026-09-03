export type MediaItem =
  | { kind: 'image-local'; value: string }
  | { kind: 'image-url'; value: string }
  | { kind: 'link'; value: string }

// Lookbehind avoids matching "s:" inside "https://" as a drive letter.
const LOCAL_PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`]+/g
const URL_RE = /https?:\/\/[^\s"'`)]+/g
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i
const MAX_ITEMS = 4

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?)\]]+$/, '')
}

export function extractMediaItems(text: string): MediaItem[] {
  const items: MediaItem[] = []
  const seen = new Set<string>()

  for (const raw of text.match(LOCAL_PATH_RE) ?? []) {
    const value = stripTrailingPunctuation(raw)
    if (seen.has(value) || !IMAGE_EXT_RE.test(value)) continue
    seen.add(value)
    items.push({ kind: 'image-local', value })
    if (items.length >= MAX_ITEMS) return items
  }

  for (const raw of text.match(URL_RE) ?? []) {
    const value = stripTrailingPunctuation(raw)
    const alreadyLinked = !IMAGE_EXT_RE.test(value) && text.includes(`](${value})`)
    if (seen.has(value) || alreadyLinked) continue
    seen.add(value)
    items.push({ kind: IMAGE_EXT_RE.test(value) ? 'image-url' : 'link', value })
    if (items.length >= MAX_ITEMS) return items
  }

  return items
}

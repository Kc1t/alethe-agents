import type { ILink } from '@xterm/xterm'

export type FileLinkKind = 'markdown' | 'image' | 'video' | 'text'

export type DetectedTerminalLink = {
  text: string
  target: string
  index: number
  displayLength: number
  kind: 'url' | 'path'

  fileKind?: FileLinkKind
}

type TerminalBufferLine = {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

type TerminalBuffer = {
  readonly length: number
  getLine(y: number): TerminalBufferLine | undefined
}

export type LogicalTerminalLine = {
  text: string
  startLine: number
}

const LINK_START_PATTERN =
  /https?:\/\/|(?<![@\w.-])(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?|(?:[A-Za-z]:\\|\\\\)|(?<![\w])(?:~\/|\/)(?=[A-Za-z0-9_.~])/gi
const URL_PROTOCOL_PATTERN = /^https?:\/\//i
const BARE_URL_PATTERN =
  /^(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?/i

const LINE_COL_SUFFIX = /:\d+(?::\d+)?$/
const MARKDOWN_EXT_PATTERN = /\.(md|markdown|mdx)$/i
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i
const VIDEO_EXT_PATTERN = /\.(mp4|m4v|mov|avi|mkv|webm|ogv)$/i
const FILE_EXT_PATTERN = /\.[A-Za-z0-9]{1,12}$/
const FILE_EXT_BOUNDARY_PATTERN =
  /\.(?:md|markdown|mdx|png|jpe?g|gif|webp|bmp|avif|ico|svg|txt|tsx?|jsx?|json|ya?ml|toml|csv|pdf|mp4|m4v|mov|avi|mkv|webm|mp3|wav|flac|m4a|zip|7z|rar|tar|gz|exe|msi|dll)(?=$|[\s),.;:])/i
const LINK_TRAILING_PUNCTUATION = /[\s),.;:]+$/

export function isVideoFilePath(path: string): boolean {
  return VIDEO_EXT_PATTERN.test(stripLineColumn(path.trim()))
}

export function isMarkdownFilePath(path: string): boolean {
  return MARKDOWN_EXT_PATTERN.test(stripLineColumn(path.trim()))
}

export function stripLineColumn(text: string): string {
  return text.replace(LINE_COL_SUFFIX, '')
}

export function classifyFileLink(text: string): FileLinkKind | undefined {
  const clean = stripLineColumn(text)
  if (MARKDOWN_EXT_PATTERN.test(clean)) return 'markdown'
  if (IMAGE_EXT_PATTERN.test(clean)) return 'image'
  if (VIDEO_EXT_PATTERN.test(clean)) return 'video'
  if (FILE_EXT_PATTERN.test(clean)) return 'text'
  return undefined
}
const HARD_LINK_DELIMITERS = new Set(['\t', '\r', '\n', '<', '>', '"', "'", '`', '|'])

function isLikelyAbsolutePath(text: string): boolean {
  if (!/^(?:~\/|\/)/.test(text)) return true
  const clean = stripLineColumn(text)
  const withoutRoot = clean.startsWith('~/') ? clean.slice(2) : clean.slice(1)
  return withoutRoot.includes('/') || FILE_EXT_PATTERN.test(clean)
}

function normalizeUrlTarget(text: string): string {
  if (URL_PROTOCOL_PATTERN.test(text)) {
    return text.replace(URL_PROTOCOL_PATTERN, (protocol) => protocol.toLowerCase())
  }
  return `${/^localhost(?::|\/|$)/i.test(text) ? 'http' : 'https'}://${text}`
}

function findLinkEnd(line: string, start: number, isUrl: boolean): number {
  const opener = line[start - 1]
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : undefined
  // The bracket caps the link, it does not define it. Returning its position outright
  // swallowed every space in between, so "(/a/b and /c/d)" came back as one link.
  const bracketEnd = closer && !isUrl ? line.indexOf(closer, start) : -1

  let end = start
  while (end < line.length) {
    if (bracketEnd !== -1 && end >= bracketEnd) break
    const char = line[end]
    if (HARD_LINK_DELIMITERS.has(char)) break
    if (isUrl && /\s/.test(char)) break
    if (char === ' ' && line[end + 1] === ' ') break
    if (char === ' ' && !isUrl) {
      const pathSoFar = line.slice(start, end)
      const endsAtDirectorySeparator =
        pathSoFar.endsWith('/') ||
        (/^(?:[A-Za-z]:\\|\\\\)/.test(pathSoFar) && pathSoFar.endsWith('\\'))
      if (endsAtDirectorySeparator) break

      // A space is only worth crossing to reach a file extension — that is what a path
      // with spaces looks like. With no extension ahead, the rest of the line is prose.
      const escaped = line[end - 1] === '\\'
      if (!escaped && !FILE_EXT_BOUNDARY_PATTERN.test(line.slice(end + 1))) break
    }

    // A second link after whitespace belongs to a separate match.
    if (char === ' ') {
      const remainder = line.slice(end + 1)
      if (/^(?:https?:\/\/|[A-Za-z]:\\|\\\\|~\/|\/)/.test(remainder)) break
    }
    end += 1

    if (!isUrl && FILE_EXT_BOUNDARY_PATTERN.test(line.slice(start, end))) break
  }
  return end
}

export function detectTerminalLinks(line: string): DetectedTerminalLink[] {
  const links: DetectedTerminalLink[] = []
  LINK_START_PATTERN.lastIndex = 0

  for (const match of line.matchAll(LINK_START_PATTERN)) {
    const index = match.index ?? 0
    if (links.some((link) => index < link.index + link.displayLength)) continue

    const isUrl = URL_PROTOCOL_PATTERN.test(match[0]) || BARE_URL_PATTERN.test(match[0])
    const raw = line.slice(index, findLinkEnd(line, index, isUrl))
    const displayText = raw.replace(LINK_TRAILING_PUNCTUATION, '')
    if (!displayText) continue

    const kind = isUrl ? 'url' : 'path'
    const text = kind === 'url' ? displayText : displayText.replace(/\\ /g, ' ')
    if (kind === 'path' && !isLikelyAbsolutePath(text)) continue
    links.push({
      text,
      target: kind === 'url' ? normalizeUrlTarget(text) : text,
      index,
      displayLength: displayText.length,
      kind,
      fileKind: kind === 'path' ? classifyFileLink(text) : undefined,
    })
  }
  return links
}

export function getLogicalTerminalLine(
  buffer: TerminalBuffer,
  bufferLineNumber: number,
): LogicalTerminalLine | null {
  let startIndex = bufferLineNumber - 1
  if (startIndex < 0 || startIndex >= buffer.length || !buffer.getLine(startIndex)) return null

  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) startIndex -= 1

  let endIndex = startIndex
  while (endIndex + 1 < buffer.length && buffer.getLine(endIndex + 1)?.isWrapped) endIndex += 1

  let text = ''
  for (let index = startIndex; index <= endIndex; index += 1) {
    text += buffer.getLine(index)?.translateToString(index === endIndex) ?? ''
  }

  return { text, startLine: startIndex + 1 }
}

export function terminalLinkRange(
  startLine: number,
  columns: number,
  link: Pick<DetectedTerminalLink, 'index' | 'displayLength'>,
) {
  const startOffset = link.index
  const endOffset = link.index + link.displayLength - 1
  return {
    start: { x: (startOffset % columns) + 1, y: startLine + Math.floor(startOffset / columns) },
    end: { x: (endOffset % columns) + 1, y: startLine + Math.floor(endOffset / columns) },
  }
}

/** Monta o `ILink` do xterm a partir de um link detectado, com o handler de menu. */
export function makeXtermLink(
  logicalLineStart: number,
  columns: number,
  link: DetectedTerminalLink,
  handlers: {
    openMenu: (event: MouseEvent, link: DetectedTerminalLink) => void
  },
): ILink {
  return {
    text: link.text,
    range: terminalLinkRange(logicalLineStart, columns, link),
    decorations: { pointerCursor: true, underline: true },
    activate: (event: MouseEvent) => handlers.openMenu(event, link),
  }
}

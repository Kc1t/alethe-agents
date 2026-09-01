import type { BrowserInspectResult } from './tauri'
import type { Project } from './types'
import { ALL_AGENT_TYPES } from './types'

const AGENT_SET = new Set<string>(ALL_AGENT_TYPES.filter((type) => type !== 'shell'))

function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r')
}

function formatImagePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

export type BrowserGrabTarget = {
  projectId: string
  terminalId: string
  ptyId: string
  label: string
}

/** Prefer the focused/active agent pane; fall back to any agent with a live PTY. */
export function resolveBrowserGrabTarget(args: {
  projects: Project[]
  preferredTerminalId?: string | null
  activeTerminal?: { projectId: string; terminalId: string } | null
}): BrowserGrabTarget | null {
  const candidates: BrowserGrabTarget[] = []
  for (const project of args.projects) {
    for (const terminal of project.terminals) {
      if (terminal.kind && terminal.kind !== 'terminal') continue
      const active =
        terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0]
      if (!active?.ptyId) continue
      if (!AGENT_SET.has(active.type)) continue
      candidates.push({
        projectId: project.id,
        terminalId: terminal.id,
        ptyId: active.ptyId,
        label: `${terminal.name} · ${active.type}`,
      })
    }
  }
  if (candidates.length === 0) return null

  const preferredId = args.preferredTerminalId ?? args.activeTerminal?.terminalId ?? null
  if (preferredId) {
    const preferred = candidates.find((item) => item.terminalId === preferredId)
    if (preferred) return preferred
  }
  if (args.activeTerminal) {
    const active = candidates.find(
      (item) =>
        item.projectId === args.activeTerminal!.projectId &&
        item.terminalId === args.activeTerminal!.terminalId,
    )
    if (active) return active
  }
  return candidates[0] ?? null
}

export function formatBrowserGrabMarkdown(
  inspect: BrowserInspectResult,
  screenshotPath?: string | null,
): string {
  const lines = [
    '## Browser element',
    '',
    `- Page: ${inspect.pageTitle || inspect.pageUrl}`,
    `- URL: ${inspect.pageUrl}`,
    `- Element: \`<${inspect.tagName}>\``,
    `- Selector: \`${inspect.selector || inspect.tagName}\``,
  ]
  if (inspect.ariaLabel) lines.push(`- Accessible name: ${inspect.ariaLabel}`)
  if (inspect.href) lines.push(`- Href: ${inspect.href}`)
  if (inspect.textSnippet) {
    lines.push('', '### Text', '', inspect.textSnippet)
  }
  if (inspect.htmlSnippet) {
    lines.push('', '### HTML', '', '```html', inspect.htmlSnippet, '```')
  }
  if (screenshotPath) {
    lines.push('', '### Screenshot', '', formatImagePath(screenshotPath))
  }
  lines.push('')
  return lines.join('\n')
}

export async function sendBrowserGrabToAgent(
  target: BrowserGrabTarget,
  markdown: string,
): Promise<void> {
  const { writePtyChunked } = await import('../components/XTermView/terminalWrite')
  const text = normalizePastedText(markdown)
  await writePtyChunked(target.ptyId, text, true)
}

export function formatBrowserPageCaptureMarkdown(args: {
  pageUrl: string
  pageTitle?: string
  screenshotPath: string
}): string {
  const title = args.pageTitle?.trim() || args.pageUrl
  return [
    '## Browser page',
    '',
    `- Page: ${title}`,
    `- URL: ${args.pageUrl}`,
    '',
    '### Screenshot',
    '',
    formatImagePath(args.screenshotPath),
    '',
  ].join('\n')
}

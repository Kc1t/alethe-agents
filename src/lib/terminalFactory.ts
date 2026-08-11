/**
 * Factories e helpers puros de Terminal/pane, extraídos do projectsStore pra
 * ficarem testáveis e reutilizáveis. Nenhum acesso a estado global — só
 * transformam dados de entrada em objetos de domínio.
 */

import { nanoid } from 'nanoid'

import { MAX_RECENT_PROJECT_TABS } from '../stores/projectsStore.constants'
import { basename } from './paths'
import type {
  AgentRuntimeProfile,
  AgentType,
  LayoutMode,
  Project,
  SubTab,
  Terminal,
  WorkspaceContainer,
  WorkspaceRecentTab,
} from './types'

/** Cria um container default pra um projeto. */
export function newContainer(
  projectId: string,
  paneIds: string[],
  layout: LayoutMode,
): WorkspaceContainer {
  return {
    projectId,
    paneIds,
    lastUsedAt: Date.now(),
    size: 0,
    internalLayout: layout,
    collapsed: false,
  }
}

export function rememberProjectTab(
  recentProjectIds: string[] | undefined,
  projectId: string,
): string[] {
  const current = (recentProjectIds ?? []).slice(0, MAX_RECENT_PROJECT_TABS)
  if (current.includes(projectId)) return current
  if (current.length < MAX_RECENT_PROJECT_TABS) return [...current, projectId]
  return [...current.slice(0, MAX_RECENT_PROJECT_TABS - 1), projectId]
}

export function rememberWorkspaceTab(
  recentTabs: WorkspaceRecentTab[] | undefined,
  tab: WorkspaceRecentTab,
): WorkspaceRecentTab[] {
  const current = (recentTabs ?? []).slice(0, MAX_RECENT_PROJECT_TABS)
  if (current.some((item) => item.kind === tab.kind && item.id === tab.id)) return current
  if (current.length < MAX_RECENT_PROJECT_TABS) return [...current, tab]
  return [...current.slice(0, MAX_RECENT_PROJECT_TABS - 1), tab]
}

export function makeDefaultTerminal(args: {
  name: string
  cwd: string
  firstTab: {
    type: AgentType
    cwd: string
    extraArgs?: string[]
    initialInput?: string
    runtimeProfile?: AgentRuntimeProfile
  }
  worktreeAgentId?: string
  gsdSyncViewer?: boolean
  ephemeralConflictAgent?: boolean
}): Terminal {
  const tabId = nanoid()
  const now = Date.now()
  return {
    id: nanoid(),
    name: args.name,
    cwd: args.cwd,
    activeTabId: tabId,
    disabled: false,
    laneVisible: null,
    lastUsedAt: now,
    worktreeAgentId: args.worktreeAgentId,
    gsdSyncViewer: args.gsdSyncViewer,
    ephemeralConflictAgent: args.ephemeralConflictAgent,
    tabs: [
      {
        id: tabId,
        type: args.firstTab.type,
        name: args.firstTab.type,
        cwd: args.firstTab.cwd,
        lastUsedAt: now,
        ptyId: null,
        extraArgs: args.firstTab.extraArgs,
        initialInput: args.firstTab.initialInput,
        runtimeProfile: args.firstTab.runtimeProfile,
        skipSessionClaim: true,
      },
    ],
  }
}

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i
const VIDEO_FILE_PATTERN = /\.(mp4|m4v|mov|avi|mkv|webm|ogv)$/i

/** Escolhe o viewer certo pela extensão. Imagem fica pra depois (precisa de backend). */
function classifyPaneKind(filePath: string): 'markdown' | 'video' | 'file' {
  if (VIDEO_FILE_PATTERN.test(filePath)) return 'video'
  return MARKDOWN_FILE_PATTERN.test(filePath) ? 'markdown' : 'file'
}

export function makeFilePane(args: { filePath: string; name?: string }): Terminal {
  // Remove o sufixo `:linha:coluna` que agents anexam (ex.: `foo.ts:42:10`) —
  // senão o read_text_file não acha o arquivo.
  const filePath = args.filePath.trim().replace(/:\d+(?::\d+)?$/, '')
  return {
    id: nanoid(),
    name: args.name?.trim() || basename(filePath) || filePath,
    cwd: '',
    activeTabId: '',
    disabled: false,
    laneVisible: null,
    lastUsedAt: Date.now(),
    tabs: [],
    kind: classifyPaneKind(filePath),
    filePath,
  }
}

export function makeDiffPane(args: {
  filePath: string
  repoRoot: string
  staged: boolean
  name?: string
}): Terminal {
  const filePath = args.filePath.trim().replace(/:\d+(?::\d+)?$/, '')
  return {
    id: nanoid(),
    name: args.name?.trim() || `Diff: ${basename(filePath) || filePath}`,
    cwd: args.repoRoot,
    activeTabId: '',
    disabled: false,
    laneVisible: null,
    lastUsedAt: Date.now(),
    tabs: [],
    kind: 'diff',
    filePath,
    staged: args.staged,
  }
}

export function makeWebPane(args: { url: string; name?: string }): Terminal {
  const url = args.url.trim()
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    // A validação ocorre no modal; mantém fallback defensivo para dados importados.
  }
  return {
    id: nanoid(),
    name: args.name?.trim() || host,
    cwd: '',
    activeTabId: '',
    disabled: false,
    laneVisible: null,
    lastUsedAt: Date.now(),
    tabs: [],
    kind: 'web',
    url,
  }
}

export function resolveTerminalCwd(terminal: Terminal | null | undefined): string {
  if (!terminal) return ''
  const activeTab = terminal.tabs.find((t) => t.id === terminal.activeTabId) ?? terminal.tabs[0]
  return activeTab?.cwd?.trim() || terminal.cwd?.trim() || ''
}

export function touchTerminalUsage(terminal: Terminal, tabId = terminal.activeTabId): Terminal {
  const now = Date.now()
  const activeTabId = terminal.tabs.some((tab) => tab.id === tabId) ? tabId : terminal.activeTabId
  return {
    ...terminal,
    lastUsedAt: now,
    activeTabId,
    tabs: terminal.tabs.map((tab) => (tab.id === activeTabId ? { ...tab, lastUsedAt: now } : tab)),
  }
}

export function pickMostRecentTab(terminal: Terminal, excludeTabId?: string): SubTab | null {
  const candidates = terminal.tabs.filter((tab) => tab.id !== excludeTabId)
  if (candidates.length === 0) return null
  return (
    [...candidates].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ?? candidates[0]
  )
}

export function collectTerminalPtyIds(terminals: Terminal[]): string[] {
  return terminals.flatMap((terminal) =>
    terminal.tabs.map((tab) => tab.ptyId).filter((ptyId): ptyId is string => Boolean(ptyId)),
  )
}

export function clearTerminalPtyIds(terminal: Terminal): Terminal {
  if (terminal.tabs.length === 0) return terminal
  return {
    ...terminal,
    tabs: terminal.tabs.map((tab) => (tab.ptyId ? { ...tab, ptyId: null } : tab)),
  }
}

/** Como clearTerminalPtyIds, mas também DESCARTA a sessão do agente (sessionId) e o
 *  badge de conclusão. Usado pelo "kill": mata o processo e reinicia do zero na
 *  próxima abertura, ao contrário do "disable" (olhinho), que preserva sessionId. */
export function resetTerminalRuntime(terminal: Terminal): Terminal {
  if (terminal.tabs.length === 0) return terminal
  return {
    ...terminal,
    tabs: terminal.tabs.map((tab) => ({
      ...tab,
      ptyId: null,
      sessionId: undefined,
      completionUnread: false,
    })),
  }
}

export function getProjectDefaultCwd(
  project: Project | null | undefined,
  projects: Project[] = [],
): string {
  if (!project) return ''
  if (project.defaultCwd?.trim()) return project.defaultCwd.trim()
  const candidates = [project]
  if (project.groupId) {
    candidates.push(...projects.filter((p) => p.id !== project.id && p.groupId === project.groupId))
  }

  for (const candidate of candidates) {
    const terminals = [...candidate.terminals].sort(
      (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
    )
    for (const terminal of terminals) {
      const cwd = resolveTerminalCwd(terminal)
      if (cwd) return cwd
    }
  }
  return ''
}

/** Casa o segmento `.alethe/worktrees/` (Windows ou POSIX) em qualquer ponto
 *  do caminho — inclusive worktrees aninhadas, onde o match mais à esquerda
 *  ainda aponta pro segmento mais externo (a raiz real). */
const ALETHE_WORKTREES_SEGMENT = /[\\/]\.alethe[\\/]worktrees[\\/]/i

/** Deriva a raiz do repo a partir do cwd de uma worktree isolada, sem git:
 *  o próprio Alethe sempre cria worktrees em `<raiz>/.alethe/worktrees/<id>`
 *  (ver `worktrees_base` em `worktrees.rs`) — cortar nesse ponto devolve a
 *  raiz original, mesmo que o cwd seja de uma worktree aninhada. */
function deriveRepoRootFromWorktreeCwd(cwd: string): string {
  const match = cwd.match(ALETHE_WORKTREES_SEGMENT)
  if (!match || match.index === undefined) return ''
  return cwd.slice(0, match.index)
}

/**
 * Como getProjectDefaultCwd, mas nunca devolve o cwd de um terminal já
 * migrado pra worktree — operações de merge/migração precisam da raiz real
 * do repositório, não de um subdiretório de worktree isolada.
 */
export function getProjectRepoRoot(project: Project | null | undefined): string {
  if (!project) return ''
  const sorted = [...project.terminals].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))

  // `gsdSyncViewer` nunca conta como "puro": o cwd dele É a worktree (só não
  // tem `worktreeAgentId` porque não é o agente isolado em si, é só um
  // viewer secundário) — sem essa exclusão ele era escolhido como referência
  // de raiz, devolvendo o path da worktree em vez do repo de verdade, e
  // quebrava a descoberta de sessões GSD Sync do próprio projeto (a raiz
  // "descoberta" batia com o cwd do terminal isolado, então o filtro de
  // `watched` nunca via nenhum terminal de worktree pra vigiar).
  const pure = sorted.filter((terminal) => !terminal.worktreeAgentId && !terminal.gsdSyncViewer)
  for (const terminal of pure) {
    const cwd = resolveTerminalCwd(terminal)
    if (cwd) return cwd
  }

  // Nenhum terminal "puro" sobrou (todos já isolados, ex.: projeto que só
  // teve agentes isolados desde o início, ou cujo terminal original foi
  // removido) — deriva a raiz a partir do padrão de path conhecido, sem
  // precisar de nenhum terminal de referência "limpo".
  for (const terminal of sorted) {
    const cwd = resolveTerminalCwd(terminal)
    const derived = cwd && deriveRepoRootFromWorktreeCwd(cwd)
    if (derived) return derived
  }
  return ''
}

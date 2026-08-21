export type AgentType =
  'shell' | 'claude' | 'codex' | 'copilot' | 'opencode' | 'freebuff' | 'mimo' | 'antigravity'

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  mimo: 'Mimo',
  freebuff: 'Freebuff',
  shell: 'Shell',
}

export const ALL_AGENT_TYPES: AgentType[] = [
  'claude',
  'codex',
  'copilot',
  'antigravity',
  'opencode',
  'mimo',
  'freebuff',
  'shell',
]

export function agentCliCommand(agent: AgentType): string | undefined {
  if (agent === 'shell') return undefined
  return agent === 'antigravity' ? 'agy' : agent
}

export type Locale = 'en' | 'pt-BR'

export type LayoutMode = 'auto' | 'spotlight' | 'sidebar' | 'grid'

export type GridCell = {
  col: number
  row: number
  colSpan: number
  rowSpan: number
}

export type GridLayout = {
  cols: number
  rows: number

  cells: Record<string, GridCell>

  colSizes?: number[]

  rowSizes?: number[]
}

export type GridLayoutHistoryEntry = {
  id: string
  savedAt: number
  layout: GridLayout
}

export type Theme =
  | 'dark'
  | 'light'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'solarized'
  | 'tokyo-night'
  | 'vscode'
  | 'min-dark'
  | 'min-light'
  | 'dark-lemon'
  | 'orca'
  | 'ember'
  | 'golden-premium'
  | 'elite-original'
  | 'elite-pure-black'
  | 'elite-indigo'
  | 'elite-blush'

/** Native desktop icon variants. The UI theme and app icon theme are independent. */
export type AppIconTheme = 'elite-original' | 'elite-pure-black' | 'elite-indigo' | 'elite-blush'

export type VisualStyle = 'normal' | 'clean'

export type MotionPreference = 'animated' | 'reduced'

export type FeatureId =
  | 'todos'
  | 'git'
  | 'browser'
  | 'graphify'
  | 'aiMemory'
  | 'mcp'
  | 'playwright'
  | 'orchestrator'

export type TodoItem = {
  id: string
  title: string
  completed: boolean
  tags: string[]

  projectId?: string
}

export type SubTab = {
  id: string
  type: AgentType
  name: string
  cwd: string

  lastUsedAt?: number

  ptyId: string | null

  completionUnread?: boolean

  sessionId?: string
  /** Args extras passados pro launcher (ex: --dangerously-skip-permissions). */
  extraArgs?: string[]

  initialInput?: string
  /** One-shot context packet used to bootstrap a cross-provider session. */
  handoff?: AgentHandoffBootstrap

  runtimeProfile?: AgentRuntimeProfile
}

export type AgentHandoffBootstrap = {
  id: string
  contextDir: string
  contextPath: string
  sourceProvider: 'claude' | 'codex'
  sourceSessionId: string
}

export type AgentRuntimeProfile = 'full' | 'lean' | 'diagnostic'

/** Flag de "modo irrestrito" por agente (skip permissions / approvals). */

/** Flag de "modo irrestrito" por agente (skip permissions / approvals). */
export const UNRESTRICTED_FLAG: Record<AgentType, string | null> = {
  shell: null,
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  copilot: '--allow-all',
  opencode: '--dangerously-skip-permissions',

  freebuff: null,
  mimo: null,
  antigravity: '--dangerously-skip-permissions',
}

export type PaneKind =
  'terminal' | 'markdown' | 'file' | 'image' | 'video' | 'web' | 'graphify' | 'diff'

export type BrowserResourceMode = 'app-first' | 'balanced' | 'keep-alive'

/**
 * `native` is a child webview positioned over the pane; `cdp` paints screencast frames from the
 * automation browser onto a canvas, which is ordinary DOM and is the same browser an agent drives.
 */
export type BrowserEngine = 'native' | 'cdp'

export type BrowserPaneConfig = {
  /** Whether scripts may run in the private webview. Defaults to true. */
  javascriptEnabled?: boolean
  /** Page zoom applied to the private webview. Defaults to 1. */
  zoom?: number
  /** How aggressively a hidden native webview is released. Defaults to app-first. */
  resourceMode?: BrowserResourceMode
  /** Which surface renders the page. Defaults to native. */
  engine?: BrowserEngine
  /**
   * Attach to this tab in the shared browser instead of opening a new one. Set when a pane is
   * created to watch a page an agent opened, so the pane shows that page rather than a copy.
   */
  watchTargetId?: string
}

export type BrowserPaneOptions = BrowserPaneConfig & {
  url: string
  name?: string
}

export type Terminal = {
  id: string
  name: string
  cwd: string
  tabs: SubTab[]
  activeTabId: string
  disabled: boolean
  laneVisible: boolean | null
  /** Keeps terminal controls in a fixed topbar instead of revealing them on hover. */
  topbarPinned?: boolean

  lastUsedAt?: number

  kind?: PaneKind

  filePath?: string

  url?: string
  /** Runtime settings for a private native browser pane. */
  browserConfig?: BrowserPaneConfig

  worktreeAgentId?: string

  staged?: boolean

  gsdSyncViewer?: boolean
  /**
   * Marks this terminal as the EPHEMERAL conflict-resolution agent
   * (`mergeStore.ts` — "born, resolves, dies"). Must never be treated as a
   * trackable agent worktree: excluded from the GSD Sync watcher/plugin
   * (`useGsdSyncSessionsWatcher`/`gsdOpenCodePluginWrite`) — without this
   * exclusion the GSD plugin got installed on this disposable terminal like
   * any normal worktree, creating a real child session that went orphaned
   * (pointing at an already-deleted folder) the moment the ephemeral agent
   * was torn down at the end of the merge.
   */
  ephemeralConflictAgent?: boolean
  /**
   * Marks a disposable utility terminal (a "Review"/"Test" session from the
   * Merge Center — born, serves manual review, dies) that must NEVER be
   * treated as a candidate "pure repository root" in `getProjectRepoRoot`.
   * These terminals have `cwd` = the worktree of the agent under review, but
   * no `worktreeAgentId`/`gsdSyncViewer`, so the root heuristic picked them
   * as a reference by mistake, contaminating `repo` with the worktree path
   * instead of the real root, and the agent's card vanished from the Merge
   * Center while the review/test session was open (same bug class already
   * fixed for `gsdSyncViewer`).
   */
  ephemeralUtility?: boolean
  /** Hides this terminal and its output from every paired remote device. */
  remoteExcluded?: boolean
}

export type PaneGroup = {
  id: string
  paneIds: string[]
}

export type OrphanWorktree = {
  path: string
  mode: 'gitWorktree' | 'localCopy'

  requiresRawDeletion?: boolean

  pruneOnly?: boolean

  cleanAttempts?: number
  /** Motivo do lock administrativo (`git worktree lock`), se for esse o bloqueio atual. */
  adminLockReason?: string
}

export type Project = {
  id: string
  name: string
  /** Determines which workspace opens when the project is selected. */
  mode?: 'standard' | 'agentSandbox'
  color?: string

  iconUrl?: string

  groupId: string | null

  defaultCwd?: string
  terminals: Terminal[]
  /** Blocos visuais criados selecionando panes com Shift. */
  paneGroups?: PaneGroup[]

  markdownComments?: MarkdownComment[]
  layoutMode: LayoutMode

  gridLayout?: GridLayout
  /** Most recently saved custom layouts for this project. */
  gridLayoutHistory?: GridLayoutHistoryEntry[]
  collapsed: boolean
  /** Hidden from the sidebar until restored from Preferences. */
  archived?: boolean
  createdAt: number
  // --- RFC-009 / RFC-003 — Multi-Agent settings ---
  worktreeMode?: 'gitWorktree' | 'localCopy'
  validationCommands?: string[]
  /** Command that boots the app for the live health probe (Test/Integrate). Must
   *  respect the PORT env var (health_probe injects a free port into it).
   *  Empty/undefined = probe disabled. */
  healthCheckCommand?: string
  /** HTTP path checked by the probe (e.g. "/", "/health"). Defaults to '/' when empty. */
  healthCheckPath?: string
  gsdWatcherEnabled?: boolean

  conflictAgentProvider?: AgentType

  conflictAgentModel?: string

  reviewAgentProvider?: AgentType

  reviewAgentModel?: string

  graphifyEnabled?: boolean

  autoWorktree?: boolean

  githubUrl?: string

  firstBootPending?: boolean

  /** Terminal behavior after a merge is accepted (relocate to a new branch or close). */
  mergePostAction?: 'relocateToNewBranch' | 'relocateKeepSession' | 'closeTerminal'

  orphanWorktrees?: OrphanWorktree[]
}

export type MarkdownComment = {
  id: string
  path: string
  quote: string
  note: string
  start: number
  end: number
  createdAt: number
}

export type Group = {
  id: string
  name: string
  color: string

  iconUrl?: string
  collapsed: boolean

  projectIds: string[]

  parentGroupId: string | null

  layoutMode?: LayoutMode

  gridLayout?: GridLayout
  /** Most recently saved custom layouts for this group. */
  gridLayoutHistory?: GridLayoutHistoryEntry[]

  suspended?: boolean

  archived?: boolean
  createdAt: number
}

export type WorkspaceContainer = {
  projectId: string

  paneIds: string[]

  lastUsedAt?: number

  size: number
  internalLayout: LayoutMode
  collapsed: boolean
}

export type WorkspaceRecentTab = {
  kind: 'project' | 'group'
  id: string
}

export type WorkspaceTabKind = 'project' | 'group' | 'terminal' | 'composition'

export type WorkspaceViewSnapshot = {
  containers: WorkspaceContainer[]
  activeProjectId: string | null
  activeGroupId: string | null
  focusedTerminalId: string | null
  workspaceFlat: boolean
  fullscreenContainerId: string | null
  workspaceGridLayout?: GridLayout
}

export type WorkspaceTab = {
  id: string
  kind: WorkspaceTabKind
  sourceId?: string
  sourceProjectId?: string
  label: string
  color?: string
  iconUrl?: string

  pinned?: boolean
  snapshot: WorkspaceViewSnapshot
  createdAt: number
  updatedAt: number
}

export type WorkspaceHistoryEntry = {
  id: string
  tabId: string
  label: string
  snapshot: WorkspaceViewSnapshot
  visitedAt: number
}

export type TerminalCreationPreset = {
  name: string
  cwd: string
  firstTab: {
    type: AgentType
    cwd: string
    extraArgs?: string[]
    runtimeProfile?: AgentRuntimeProfile
  }
}

export type Preferences = {
  /** Idioma da UI. Default 'en'. */
  language: Locale
  uiTheme: Theme
  /** Application-wide visual language. Normal preserves the production UI. */
  visualStyle: VisualStyle
  /** Controls decorative motion while preserving static artwork. */
  motionPreference: MotionPreference
  /** Native desktop icon theme. Defaults to Dark independently from the UI theme. */
  appIconTheme: AppIconTheme
  /** Zoom global da WebView. 1 = 100%. */
  uiZoom: number

  windowOpacity: number
  terminalTheme: Theme | null
  enabledAgents: Record<AgentType, boolean>
  onboardingDone: boolean

  workspaceFlat: boolean

  fullscreenContainerId: string | null

  isolatedPaneId: string | null

  firstLaunchAt: number | null
  /** Nome exibido no welcome modal. */
  displayName: string
  /** URL da foto de perfil escolhida no cadastro local. */
  profileImageUrl: string

  accountCreated: boolean

  alwaysStartOnHome: boolean

  alwaysStartUnrestricted: boolean
  /** Last terminal configuration submitted through the creation modal. */
  lastTerminalCreation: TerminalCreationPreset | null

  topbarStyle: 'classic' | 'three-areas'
  /** Local do controle Git: sidebar esquerda ou direita. */
  gitControlPlacement: 'left' | 'right'

  /** Credenciais locais do Spotify Developer Dashboard para Now Playing. */
  spotifyClientId: string
  spotifyClientSecret: string
  /** Exibe a atividade atual do Alethe no perfil do Discord. */
  discordRichPresenceEnabled: boolean
  /** Itens opcionais exibidos no canto direito da topbar. */
  topbarShowClaudeUsage: boolean
  topbarShowCodexUsage: boolean
  topbarShowAntigravityUsage: boolean
  topbarShowSync: boolean
  topbarShowProfile: boolean
  topbarShowMemory: boolean
  /** Starts the LAN remote listener on launch. Off until the user opts in. */
  remoteEnabled: boolean
  /** Maximum number of authenticated LAN remote devices. Default 1. */
  remoteMaxDevices: number
  /** Remote session lifetime in seconds. Default 1 hour. */
  remoteSessionExpirySecs: number
  /** Paired devices can read terminals but never send input. Default true. */
  remoteReadOnly: boolean
  /** Allows remote input on plain shell tabs, not only agent tabs. Default false. */
  remoteAllowShellInput: boolean

  enabledFeatures: Record<FeatureId, boolean>
  /** Folder configured as the base location for the global Todo list. */
  todoStoragePath: string
  /** Scope the MCP panel opens on. */
  mcpDefaultScope: McpScope
  /** True once the MCP setup prompt has been shown or dismissed. */
  mcpOnboardingSeen: boolean

  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  leftSidebarWidth: number
  rightSidebarWidth: number

  notifyOnLimitReset: boolean
  /** Ditado por voz (speech-to-text) escreve no terminal ativo. Default false. */
  dictationEnabled: boolean
  /** Quantos PTYs podem ser spawnados em paralelo (fila global). Default 3. */
  spawnConcurrency: number

  resourcePolicy: ResourcePolicyPreferences

  workspaceGridLayout?: GridLayout
  /** Most recently saved custom layouts for the workspace. */
  workspaceGridLayoutHistory?: GridLayoutHistoryEntry[]

  nativeTerminalMacos?: boolean
  /**
   * v3 — perfil de heap do Node.js para agentes (Claude, Codex, OpenCode).
   * Injeta --max-old-space-size e UV_THREADPOOL_SIZE no ambiente do PTY.
   */
  nodeHeapProfile?: 'conservative' | 'balanced' | 'performance'

  gsdSyncModelChain?: string[]
}

export type ResourcePolicyMode = 'smart-lru' | 'manual'

export type ResourcePolicyPreferences = {
  mode: ResourcePolicyMode
  /** True only after the user explicitly enables automatic runtime parking. */
  automaticParkingOptIn: boolean
  memoryBudgetMb: number
  warningThresholdMb: number
  recoveryTargetMb: number
  hiddenAgentIdleMinutes: number
  hiddenShellIdleMinutes: number
  spawnGraceSeconds: number
}

export type ProjectsFile = {
  version: 7
  groups: Group[]

  ungroupedOrder: string[]
  projects: Project[]

  todos: TodoItem[]
  activeProjectId: string | null

  workspace: {
    containers: WorkspaceContainer[]

    recentProjectIds: string[]

    recentTabs: WorkspaceRecentTab[]

    tabs: WorkspaceTab[]

    closedTabs?: WorkspaceTab[]
    activeTabId: string | null
    activeGroupId: string | null
    focusedTerminalId: string | null
    history: WorkspaceHistoryEntry[]
    historyIndex: number
  }
  preferences: Preferences
  cliPaths: Partial<Record<AgentType, string>>
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: 'en',
  uiTheme: 'elite-indigo',
  visualStyle: 'normal',
  motionPreference: 'animated',
  appIconTheme: 'elite-indigo',
  uiZoom: 1,
  windowOpacity: 1,
  terminalTheme: null,
  enabledAgents: {
    shell: true,
    claude: true,
    codex: true,
    copilot: true,
    antigravity: true,
    opencode: true,
    freebuff: true,
    mimo: true,
  },
  onboardingDone: false,
  workspaceFlat: false,
  fullscreenContainerId: null,
  isolatedPaneId: null,
  firstLaunchAt: null,
  displayName: '',
  profileImageUrl: '',
  accountCreated: false,
  alwaysStartOnHome: false,
  alwaysStartUnrestricted: false,
  lastTerminalCreation: null,
  topbarStyle: 'classic',
  gitControlPlacement: 'left',
  spotifyClientId: '',
  spotifyClientSecret: '',
  discordRichPresenceEnabled: false,
  topbarShowClaudeUsage: true,
  topbarShowCodexUsage: true,
  topbarShowAntigravityUsage: true,
  topbarShowSync: true,
  topbarShowProfile: true,
  topbarShowMemory: true,
  remoteEnabled: false,
  remoteMaxDevices: 1,
  remoteSessionExpirySecs: 3600,
  remoteReadOnly: true,
  remoteAllowShellInput: false,
  enabledFeatures: {
    todos: true,
    git: true,
    browser: true,
    graphify: true,
    aiMemory: false,
    mcp: true,
    playwright: false,
    orchestrator: false,
  },
  todoStoragePath: '',
  mcpDefaultScope: 'global',
  mcpOnboardingSeen: false,
  leftSidebarVisible: true,
  rightSidebarVisible: true,
  leftSidebarWidth: 286,
  rightSidebarWidth: 300,
  notifyOnLimitReset: true,
  dictationEnabled: false,
  spawnConcurrency: 3,
  resourcePolicy: {
    mode: 'manual',
    automaticParkingOptIn: false,
    memoryBudgetMb: 1536,
    warningThresholdMb: 1229,
    recoveryTargetMb: 1152,
    hiddenAgentIdleMinutes: 15,
    hiddenShellIdleMinutes: 30,
    spawnGraceSeconds: 120,
  },
  nodeHeapProfile: 'balanced',
}

export const EMPTY_PROJECTS_FILE: ProjectsFile = {
  version: 7,
  groups: [],
  ungroupedOrder: [],
  projects: [],
  todos: [],
  activeProjectId: null,
  workspace: {
    containers: [],
    recentProjectIds: [],
    recentTabs: [],
    tabs: [],
    closedTabs: [],
    activeTabId: null,
    activeGroupId: null,
    focusedTerminalId: null,
    history: [],
    historyIndex: -1,
  },
  preferences: DEFAULT_PREFERENCES,
  cliPaths: {},
}

export type PtyStatus = 'working' | 'waiting' | 'stopped' | 'disabled' | 'offline'

export const GROUP_COLORS = [
  '#6ea8ff',
  '#22d3ee',
  '#a78bfa',
  '#34d399',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#10b981',
] as const

export const PROVIDER_MODELS: Record<AgentType, { id: string; label: string }[]> = {
  claude: [
    { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet (Padrão)' },
    { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus', label: 'Claude 3 Opus' },
  ],
  codex: [
    { id: 'gpt-4o', label: 'GPT-4o (Padrão)' },
    { id: 'o3-mini', label: 'o3-mini (Raciocínio)' },
    { id: 'o1', label: 'o1 (Avançado)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  ],
  copilot: [],
  opencode: [
    { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (Raciocínio)' },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3' },
    { id: 'qwen/qwen-2.5-coder-32b', label: 'Qwen 2.5 Coder 32B' },
    { id: 'meta-llama/llama-3.3-70b', label: 'Llama 3.3 70B' },
  ],
  antigravity: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Padrão)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
  ],
  mimo: [
    { id: 'mimo-pro', label: 'Mimo Pro' },
    { id: 'mimo-flash', label: 'Mimo Flash' },
  ],
  freebuff: [{ id: 'freebuff-auto', label: 'Freebuff Auto' }],
  shell: [{ id: 'default', label: 'Shell Padrão' }],
}

export type McpScope = 'global' | 'project'

export type McpAgent = Extract<AgentType, 'claude' | 'codex' | 'opencode' | 'antigravity'>

export const MCP_AGENTS: McpAgent[] = ['claude', 'codex', 'opencode', 'antigravity']

/** Literal values never leave Rust: `preview` is masked, use mcpRevealEnv for the real one. */
export type McpEnvEntry = {
  literal: { preview: string; empty: boolean } | null
  passthroughFrom: string | null
}

export type McpTransport =
  | { kind: 'stdio'; command: string; args: string[]; cwd: string | null }
  | { kind: 'http'; url: string; headers: Record<string, McpEnvEntry> }
  | { kind: 'sse'; url: string; headers: Record<string, McpEnvEntry> }

export type McpTimeouts = {
  startupSecs: number | null
  toolSecs: number | null
}

export type McpServer = {
  name: string
  transport: McpTransport
  env: Record<string, McpEnvEntry>
  enabled: boolean
  timeouts: McpTimeouts
  bearerTokenEnvVar: string | null
}

/**
 * `local` is Claude's default `claude mcp add` target: the servers it keeps inside
 * `~/.claude.json` under `projects.<cwd>` rather than in the repo's `.mcp.json`.
 */
export type McpSourceKind = 'user' | 'local' | 'project'

export type McpSourceState = {
  kind: McpSourceKind
  path: string
  exists: boolean
  writable: boolean
  parseError: string | null
  mtimeMs: number
}

export type McpServerRecord = {
  server: McpServer
  agent: McpAgent
  scope: McpScope
  sourceKind: McpSourceKind
  sourcePath: string
  managedByImport: string | null
}

export type McpAgentSnapshot = {
  agent: McpAgent
  scope: McpScope
  sources: McpSourceState[]
  servers: McpServerRecord[]
}

export type McpCapability = {
  agent: McpAgent
  projectScope: boolean
  enabledFlag: boolean
  envPassthrough: boolean
  timeouts: boolean
  headers: boolean
  remote: boolean
}

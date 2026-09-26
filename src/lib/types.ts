/** Agent providers that ship with the app; their data lives in this file. */
export type BuiltinAgentType =
  | 'shell'
  | 'wsl'
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'opencode'
  | 'freebuff'
  | 'mimo'
  | 'antigravity'
  | 'kiro'
  | 'kimi'

/**
 * An agent type id. Open on purpose: plugins contribute agent providers at
 * runtime, so an unknown string here is a contributed provider, not a bug. Use
 * `isBuiltinAgentType` or the resolvers in `agentProviders.ts` before assuming
 * an id resolves.
 */
export type AgentType = BuiltinAgentType | (string & {})

export const AGENT_TYPE_LABELS: Record<BuiltinAgentType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  mimo: 'Mimo',
  freebuff: 'Freebuff',
  kiro: 'Kiro CLI',
  kimi: 'Kimi Code',
  shell: 'Shell',
  wsl: 'WSL',
}

export const ALL_AGENT_TYPES: BuiltinAgentType[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'antigravity',
  'opencode',
  'mimo',
  'freebuff',
  'kiro',
  'kimi',
  'shell',
  'wsl',
]

/** Types that open a plain shell — no agent CLI session semantics. */
export function isShellAgentType(agent: AgentType): boolean {
  return agent === 'shell' || agent === 'wsl'
}

/** Built-in CLI binary, when it differs from the agent id. */
const BUILTIN_CLI_COMMANDS: Partial<Record<BuiltinAgentType, string | null>> = {
  shell: null,
  wsl: 'wsl.exe',
  antigravity: 'agy',
  cursor: 'cursor-agent',
  kiro: 'kiro-cli',
}

/** Built-ins only. Use `resolveAgentCliCommand` to also reach contributed providers. */
export function agentCliCommand(agent: AgentType): string | undefined {
  if (!(agent in AGENT_TYPE_LABELS)) return undefined
  const mapped = BUILTIN_CLI_COMMANDS[agent as BuiltinAgentType]
  if (mapped === null) return undefined
  return mapped ?? agent
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

/** Themes whose token blocks live in `src/styles/theme.css`. */
export type BuiltinTheme =
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
  | 'elite-original'
  | 'elite-pure-black'
  | 'elite-indigo'
  | 'elite-blush'
  | 'catppuccin-frappe'
  | 'gruvbox-material'

/**
 * A theme id. Open on purpose: plugins contribute themes at runtime, so an
 * unknown string here is a plugin theme, not a bug. Use `isBuiltinTheme` or the
 * theme registry before assuming an id resolves.
 */
export type Theme = BuiltinTheme | (string & {})

/** Native desktop icon variants. The UI theme and app icon theme are independent. */
export type AppIconTheme = 'elite-original' | 'elite-pure-black' | 'elite-indigo' | 'elite-blush'

export type VisualStyle = 'normal' | 'clean'

export type MotionPreference = 'animated' | 'reduced'

export type SetupWalkthroughStep = 'project' | 'appearance'

export const SETUP_WALKTHROUGH_STEPS: SetupWalkthroughStep[] = ['project', 'appearance']

export type FeatureId =
  'browser' | 'graphify' | 'aiMemory' | 'mcp' | 'playwright' | 'orchestrator' | 'prs' | 'gsdSync'

export type TodoItem = {
  id: string
  title: string
  completed: boolean
  tags: string[]

  projectId?: string

  /** Set when this todo was created from a GitHub PR via the Open PRs tab. */
  prUrl?: string
  prNumber?: number
  /** "owner/name". */
  prRepo?: string
}

export type PomodoroPhase = 'idle' | 'work' | 'shortBreak' | 'longBreak'
export type PomodoroStatus = 'idle' | 'running' | 'paused' | 'finished'

/** Durable snapshot mirrored from `pomodoroStore` into `preferences` so a running
 *  session survives an app restart (see `src/stores/pomodoroStore.ts`). */
export type PomodoroSessionSnapshot = {
  phase: PomodoroPhase
  status: PomodoroStatus
  /** Epoch ms when the current phase ends. Null when idle or paused. */
  endsAt: number | null
  /** Frozen remaining time, set only while paused. */
  remainingMsAtPause: number | null
  cyclesCompleted: number
  focusTodoId: string | null
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
  /** Route this agent's API traffic through the local 9router proxy. */
  useRouter9?: boolean
}

export type AgentHandoffBootstrap = {
  id: string
  contextDir: string
  contextPath: string
  sourceProvider: 'claude' | 'codex'
  sourceSessionId: string
}

export type AgentRuntimeProfile = 'full' | 'lean' | 'diagnostic'

/** Unrestricted-mode flag per agent (skip permissions / approvals). */
export const UNRESTRICTED_FLAG: Record<BuiltinAgentType, string | null> = {
  shell: null,
  wsl: null,
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  copilot: '--allow-all',
  cursor: '--force',
  opencode: '--dangerously-skip-permissions',

  freebuff: null,
  mimo: null,
  antigravity: '--dangerously-skip-permissions',
  kiro: '--trust-all-tools',
  kimi: '--yolo',
}

export type PaneKind =
  | 'terminal'
  | 'markdown'
  | 'file'
  | 'image'
  | 'video'
  | 'web'
  | 'graphify'
  | 'diff'
  | 'orchestrator'
  | 'plugin'

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
  gridId?: string
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

  /** The plugin this pane shows the profile of, on a `plugin` pane. */
  pluginId?: string

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
  /** @deprecated Migration-only. Superseded by `remoteShared` (opt-in). */
  remoteExcluded?: boolean
  /** Exposes this terminal and its output to paired remote devices. Off by default. */
  remoteShared?: boolean
}

export type PaneGroup = {
  id: string
  paneIds: string[]
  /** Dedicated groups keep related panes together without changing the project's outer layout. */
  kind?: 'orchestration'
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

export type ProjectGrid = {
  id: string
  name: string
  collapsed: boolean
  layoutMode: LayoutMode
  gridLayout?: GridLayout
  gridLayoutHistory?: GridLayoutHistoryEntry[]
}

export type Project = {
  grids?: ProjectGrid[]
  activeGridId?: string
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
  /** Kept out of the sidebar until hidden projects are revealed for the session. */
  hidden?: boolean
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
  /** Present for a project grid; absent for explicitly composed pane selections. */
  gridId?: string
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
    useRouter9?: boolean
  }
}

export const ROUTER9_DEFAULT_PORT = 20128

/** Which 9router install Alethe runs: the one it manages, or one the user installed themselves. */
export type Router9Source = 'managed' | 'external'

/** Local 9router proxy. Opt-in and off by default — nothing is installed or started implicitly. */
export type Router9Preferences = {
  enabled: boolean
  autoStart: boolean
  source: Router9Source
  port: number
  /** Endpoint key issued by the 9router dashboard. Stored in plaintext, like the Spotify secret. */
  apiKey: string
  defaultForNewAgents: boolean
}

export const DEFAULT_ROUTER9_PREFERENCES: Router9Preferences = {
  enabled: false,
  autoStart: false,
  source: 'managed',
  port: ROUTER9_DEFAULT_PORT,
  apiKey: '',
  defaultForNewAgents: false,
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
  /** @deprecated Migrated into `viewPlacements.git`. Read only by the migration. */
  gitControlPlacement?: 'left' | 'right'
  /** Sidebar a contributed view sits in, overriding the container its manifest declares. */
  viewPlacements: Record<string, 'left' | 'right'>

  /** Credenciais locais do Spotify Developer Dashboard para Now Playing. */
  spotifyClientId: string
  spotifyClientSecret: string
  /** Exibe a atividade atual do Alethe no perfil do Discord. */
  discordRichPresenceEnabled: boolean
  /** Usage cards shown in the AI usage details modal and the home usage strip. */
  usageShowClaude: boolean
  usageShowCodex: boolean
  usageShowAntigravity: boolean
  /** Itens opcionais exibidos no canto direito da topbar. */
  topbarShowClaudeUsage: boolean
  topbarShowCodexUsage: boolean
  topbarShowAntigravityUsage: boolean
  topbarShowSync: boolean
  topbarShowProfile: boolean
  topbarShowMemory: boolean
  /** Status pill for the local 9router proxy, with a one-click stop. */
  topbarShowRouter9: boolean
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
  /** Binds the remote listener to the machine's Tailscale address instead of the LAN. Default false. */
  remoteUseTailscale: boolean

  enabledFeatures: Record<FeatureId, boolean>
  /** Playwright MCP: attach to the shared/pane browser, or launch its own. */
  playwrightBrowserMode: 'shared' | 'dedicated'
  /** Only used when playwrightBrowserMode is 'dedicated'. */
  playwrightDedicatedHeadless: boolean
  /** Legacy: the Todo List plugin owns this now. Read by its migration only. */
  todoStoragePath: string
  /** Scope the MCP panel opens on. */
  mcpDefaultScope: McpScope
  /** True once the MCP setup prompt has been shown or dismissed. */
  mcpOnboardingSeen: boolean

  /** Home checklist that continues the setup after onboarding hands over the app. */
  setupWalkthrough: Record<SetupWalkthroughStep, boolean>
  /** True once the user dismisses the Home checklist by hand. */
  setupWalkthroughHidden: boolean

  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  leftSidebarWidth: number
  rightSidebarWidth: number

  notifyOnLimitReset: boolean
  /** Local speech-to-text into the active terminal. Off by default. */
  dictationEnabled: boolean
  /** Toggle = press Ctrl+E to start/stop; Hold = dictate while Ctrl+E is held. */
  dictationMode: 'toggle' | 'hold'
  /** Selected on-device STT model id (Parakeet TDT v3 by default). */
  dictationModelId: string
  /** Preferred microphone deviceId, or null for the OS default. */
  dictationMicrophoneId: string | null
  /** Cached microphone label when the preferred device is unplugged. */
  dictationMicrophoneLabel: string | null
  /** Decisions API key for voice commands. Empty disables the command bar. */
  voiceCommandApiKey: string
  /** How many PTYs may spawn in parallel (global queue). Default 3. */
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

  router9?: Router9Preferences

  /** Pomodoro cycle durations, in minutes. */
  pomodoroWorkMinutes: number
  pomodoroShortBreakMinutes: number
  pomodoroLongBreakMinutes: number
  /** Mirrors `pomodoroStore`'s running session so it survives an app restart. */
  pomodoroSession: PomodoroSessionSnapshot | null
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
  version: 9
  groups: Group[]

  ungroupedOrder: string[]
  projects: Project[]

  /**
   * Owned by the Todo List plugin now, and read only by its one-time
   * migration. Kept persisted so removing the plugin cannot lose the list.
   */
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
    wsl: true,
    claude: true,
    codex: true,
    copilot: true,
    cursor: true,
    antigravity: true,
    opencode: true,
    freebuff: true,
    mimo: true,
    kiro: true,
    kimi: true,
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
  viewPlacements: {},
  spotifyClientId: '',
  spotifyClientSecret: '',
  discordRichPresenceEnabled: false,
  usageShowClaude: true,
  usageShowCodex: true,
  usageShowAntigravity: true,
  topbarShowClaudeUsage: true,
  topbarShowCodexUsage: true,
  topbarShowAntigravityUsage: true,
  topbarShowSync: true,
  topbarShowProfile: true,
  topbarShowMemory: true,
  topbarShowRouter9: false,
  remoteEnabled: false,
  remoteMaxDevices: 1,
  remoteSessionExpirySecs: 3600,
  remoteReadOnly: true,
  remoteAllowShellInput: false,
  remoteUseTailscale: false,
  enabledFeatures: {
    browser: true,
    graphify: true,
    aiMemory: false,
    gsdSync: false,
    mcp: true,
    playwright: false,
    orchestrator: false,
    prs: true,
  },
  playwrightBrowserMode: 'shared',
  playwrightDedicatedHeadless: false,
  todoStoragePath: '',
  mcpDefaultScope: 'global',
  mcpOnboardingSeen: false,
  setupWalkthrough: { project: false, appearance: false },
  setupWalkthroughHidden: false,
  leftSidebarVisible: true,
  rightSidebarVisible: true,
  leftSidebarWidth: 286,
  rightSidebarWidth: 300,
  notifyOnLimitReset: true,
  dictationEnabled: false,
  dictationMode: 'toggle',
  dictationModelId: 'parakeet-tdt-0.6b-v3-int8',
  dictationMicrophoneId: null,
  dictationMicrophoneLabel: null,
  voiceCommandApiKey: '',
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
  pomodoroWorkMinutes: 25,
  pomodoroShortBreakMinutes: 5,
  pomodoroLongBreakMinutes: 15,
  pomodoroSession: null,
}

export const EMPTY_PROJECTS_FILE: ProjectsFile = {
  version: 9,
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

export const PROVIDER_MODELS: Record<BuiltinAgentType, { id: string; label: string }[]> = {
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
  // Cursor rotates its model list per account and answers `cursor-agent models`, so nothing is
  // hardcoded here — discovery fills the picker.
  cursor: [],
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
  kiro: [
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (Padrão)' },
    { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  ],
  // Kimi Code uses the account default model established at login, so nothing is
  // hardcoded here — the same rationale as `cursor`.
  kimi: [],
  shell: [{ id: 'default', label: 'Shell Padrão' }],
  wsl: [{ id: 'default', label: 'WSL' }],
}

export type McpScope = 'global' | 'project'

export type McpAgent = Extract<
  BuiltinAgentType,
  'claude' | 'codex' | 'cursor' | 'opencode' | 'antigravity' | 'kimi'
>

export const MCP_AGENTS: McpAgent[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'antigravity',
  'kimi',
]

/**
 * Agents whose CLI can report how each configured server is actually doing. The others only have
 * their config file read back, so the panel has no live status to offer for them.
 */
export const MCP_HEALTH_AGENTS: McpAgent[] = ['claude', 'codex', 'opencode']

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

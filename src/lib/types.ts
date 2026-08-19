export type AgentType =
  'shell' | 'claude' | 'codex' | 'opencode' | 'freebuff' | 'mimo' | 'antigravity'

/** Rótulo de exibição de cada agente — fonte única, evita listas paralelas
 * divergentes por componente (ex.: "Claude" vs "Claude Code" pro mesmo tipo). */
export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  mimo: 'Mimo',
  freebuff: 'Freebuff',
  shell: 'Shell',
}

/** Ordem canônica de exibição dos tipos de agente — fonte única, evita duas
 * listas paralelas divergindo (ex.: posição do Shell diferente entre o
 * seletor de novo terminal e o de agente de conflito). */
export const ALL_AGENT_TYPES: AgentType[] = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'mimo',
  'freebuff',
  'shell',
]

/** Executável real de cada agente. O Antigravity desktop usa `antigravity`,
 * enquanto o agente de terminal oficial usa `agy`. */
export function agentCliCommand(agent: AgentType): string | undefined {
  if (agent === 'shell') return undefined
  return agent === 'antigravity' ? 'agy' : agent
}

/** Idiomas suportados pela UI. `en` é o default. */
export type Locale = 'en' | 'pt-BR'

export type LayoutMode = 'auto' | 'spotlight' | 'sidebar' | 'grid'

/** Posição/tamanho de uma Célula no grid. Coordenadas 1-based (CSS Grid style). */
export type GridCell = {
  col: number
  row: number
  colSpan: number
  rowSpan: number
}

/** Layout 'grid' — cols/rows fixas, cada filho colocado por id em uma Cell. */
export type GridLayout = {
  cols: number
  rows: number
  /** childId → posição. childId é Terminal.id (em projeto) ou Project.id (em grupo). */
  cells: Record<string, GridCell>
  /** Largura proporcional de cada coluna em `fr`. Default = todos `1` (iguais). */
  colSizes?: number[]
  /** Altura proporcional de cada linha em `fr`. Default = todos `1` (iguais). */
  rowSizes?: number[]
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

/** Native desktop icon variants. The UI theme and app icon theme are independent. */
export type AppIconTheme = Theme | 'alethe-blue-gradient' | 'alethe-pink-gradient'

/** Módulos opcionais que podem ser ativados no onboarding ou nas Preferências. */
export type FeatureId = 'todos' | 'git' | 'browser' | 'graphify' | 'aiMemory'

/** Item da lista pessoal global. A ordem do array é a ordem escolhida pelo usuário. */
export type TodoItem = {
  id: string
  title: string
  completed: boolean
  tags: string[]
  /** Projeto ao qual a tarefa está vinculada, quando aplicável. */
  projectId?: string
}

export type SubTab = {
  id: string
  type: AgentType
  name: string
  cwd: string
  /** Última vez que esta sub-tab foi ativada. Usada pra restaurar o último chat. */
  lastUsedAt?: number
  /** ID do PTY no backend. null quando o terminal está disabled ou ainda não foi spawnado. */
  ptyId: string | null
  /** Resposta concluída e notificada, ainda não vista pelo usuário. */
  completionUnread?: boolean
  /** ID de sessão pra Claude/Codex/OpenCode (--continue / resume). */
  sessionId?: string
  /** Args extras passados pro launcher (ex: --dangerously-skip-permissions). */
  extraArgs?: string[]
  /** Prompt enviado uma única vez assim que o processo novo fica pronto. */
  initialInput?: string
  /** Perfil de custo do runtime. Ausente preserva o comportamento completo legado. */
  runtimeProfile?: AgentRuntimeProfile
  /**
   * `true` só na criação da tab, consumido (limpo) no primeiro spawn.
   * Impede o fallback de "reivindicar a conversa OpenCode mais recente
   * ainda não pega nesse cwd" (pensado pra recuperar depois de reiniciar o
   * app, quando o localStorage se perde) de herdar sem querer uma sessão
   * antiga de OUTRO projeto/uso anterior da mesma pasta, num terminal
   * genuinamente novo que nunca rodou antes.
   */
  skipSessionClaim?: boolean
}

export type AgentRuntimeProfile = 'full' | 'lean' | 'diagnostic'

/** Flag de "modo irrestrito" por agente (skip permissions / approvals). */

/** Flag de "modo irrestrito" por agente (skip permissions / approvals). */
export const UNRESTRICTED_FLAG: Record<AgentType, string | null> = {
  shell: null,
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  opencode: '--dangerously-skip-permissions',
  // freebuff/mimo não documentam flag de skip-permissions própria.
  freebuff: null,
  mimo: null,
  antigravity: '--dangerously-skip-permissions',
}

/**
 * Tipo de pane. Ausente = 'terminal' (back-compat, sem migração).
 * Viewers usam `tabs: []`; arquivos usam `filePath` e páginas web usam `url`.
 */
export type PaneKind =
  'terminal' | 'markdown' | 'file' | 'image' | 'video' | 'web' | 'graphify' | 'diff'

export type Terminal = {
  id: string
  name: string
  cwd: string
  tabs: SubTab[]
  activeTabId: string
  disabled: boolean
  laneVisible: boolean | null
  /** Última vez que esse terminal foi aberto/focado. Usado pra ordenar a Home. */
  lastUsedAt?: number
  /** Discriminador de pane. Ausente/undefined = 'terminal'. Viewers de arquivo usam `tabs: []`. */
  kind?: PaneKind
  /** Caminho absoluto do arquivo quando o pane é um viewer (markdown/file/image). */
  filePath?: string
  /** URL http(s) normalizada quando kind === 'web'. */
  url?: string
  /** RFC-003 — id da worktree onde este pane vive (habilita o botão "Integrar"). */
  worktreeAgentId?: string
  /** Argumento específico para diff viewer, true se staged. */
  staged?: boolean
  /**
   * Marca este terminal como o "viewer" (só leitura) de uma sessão-filha GSD
   * Sync (criado por `useGsdSyncSessionsWatcher`). Nunca deve ser inserido
   * em `paneIds` — o único jeito de abrir é pela gaveta GSD Sync, que usa o
   * fullscreen de container isolando essa pane (`isolatedPaneId`), nunca a
   * grade normal do projeto. Também escondido da árvore de terminais da
   * Sidebar de Projetos (esquerda) — sem como digitar nela, não faz sentido
   * misturada com terminais interativos normais.
   */
  gsdSyncViewer?: boolean
  /**
   * Marca este terminal como o agente EFÊMERO de resolução de conflito
   * (`mergeStore.ts` — "nasce, resolve, morre"). Nunca deve ser tratado como
   * um worktree de agente rastreável: exclui do watcher/plugin GSD Sync
   * (`useGsdSyncSessionsWatcher`/`gsdOpenCodePluginWrite`) — confirmado ao
   * vivo que, sem essa exclusão, o plugin GSD era instalado nesse terminal
   * descartável igual a qualquer worktree normal, criando uma sessão-filha
   * de verdade que ficava órfã (apontando pra uma pasta já apagada) assim
   * que o agente efêmero era encerrado ao final do merge.
   */
  ephemeralConflictAgent?: boolean
  /**
   * Marca um terminal utilitário descartável (sessão de "Revisar"/"Testar" da
   * Central de Merges — nasce, serve pra revisão manual, morre) que NUNCA
   * deve ser tratado como candidato a "raiz pura do repositório" em
   * `getProjectRepoRoot`. Bug real, confirmado ao vivo: esses terminais têm
   * `cwd` = a worktree do agente sendo revisado, mas não tinham
   * `worktreeAgentId`/`gsdSyncViewer` — a heurística de raiz os escolhia como
   * referência por engano, contaminando `repo` com o path da worktree em vez
   * da raiz de verdade, e o card do agente sumia da Central de Merges
   * enquanto a sessão de revisão/teste estivesse aberta (mesma classe de bug
   * já corrigida antes só para `gsdSyncViewer`).
   */
  ephemeralUtility?: boolean
}

/** Bloco visual persistente que reúne panes independentes dentro de um projeto. */
export type PaneGroup = {
  id: string
  paneIds: string[]
}

/**
 * Registro de worktree "órfã" — uma pasta/registro que sobrou de uma limpeza
 * que não terminou (deleção física falhou, ou `git worktree prune` falhou
 * depois da deleção física ter dado certo). Rastreado em `Project.orphanWorktrees`
 * pra sobreviver a reloads e ser retentado/exibido pela UI.
 */
export type OrphanWorktree = {
  path: string
  mode: 'gitWorktree' | 'localCopy'
  /** Deleção física da pasta falhou/ficou parcial — tenta de novo antes de prune. */
  requiresRawDeletion?: boolean
  /** Pasta já foi apagada fisicamente; só falta `git worktree prune` no repo pai. */
  pruneOnly?: boolean
  /** Tentativas de limpeza sem avanço real. >=3 mostra alerta de remoção manual. */
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
  /** URL de imagem pequena pra representar o projeto na sidebar/topbar/container. */
  iconUrl?: string
  /** ID do grupo. null = solto (sem grupo). v2. */
  groupId: string | null
  /** Pasta padrão usada ao criar novos terminais neste projeto. */
  defaultCwd?: string
  terminals: Terminal[]
  /** Blocos visuais criados selecionando panes com Shift. */
  paneGroups?: PaneGroup[]
  /** Comentários locais ancorados em trechos de arquivos Markdown do projeto. */
  markdownComments?: MarkdownComment[]
  layoutMode: LayoutMode
  /** Definição do grid quando layoutMode === 'grid'. Persistida pra restaurar. */
  gridLayout?: GridLayout
  collapsed: boolean
  /** Hidden from the sidebar until restored from Preferences. */
  archived?: boolean
  createdAt: number
  // --- RFC-009 / RFC-003 — Multi-Agent settings ---
  worktreeMode?: 'gitWorktree' | 'localCopy'
  validationCommands?: string[]
  /** Comando que sobe o app pra probe de saúde ao vivo (Testar/Integrar). Deve
   *  respeitar a variável de ambiente PORT (health_probe injeta uma porta
   *  livre nela). Vazio/undefined = probe desabilitado. */
  healthCheckCommand?: string
  /** Caminho HTTP checado pelo probe (ex.: "/", "/health"). Default '/' quando vazio. */
  healthCheckPath?: string
  gsdWatcherEnabled?: boolean
  /** RFC-007 — CLI que resolve conflitos de merge (provider-agnóstico). Default 'claude'. */
  conflictAgentProvider?: AgentType
  /** Modelo específico do provedor para resolução de conflitos. */
  conflictAgentModel?: string
  /** CLI que revisa a branch antes do merge (botão "Revisar" da Central de Merges). Default 'claude'. */
  reviewAgentProvider?: AgentType
  /** Modelo específico do provedor para revisão de branch. */
  reviewAgentModel?: string
  /** RFC-004 — injeta o MCP do Graphify (--mcp-config) nos agentes deste projeto. */
  graphifyEnabled?: boolean
  /** RFC-003 — todo terminal de agente novo nasce numa worktree própria. */
  autoWorktree?: boolean
  /** URL do repositório de origem no GitHub. */
  githubUrl?: string
  /** Indica se a workspace precisa disparar a injeção inicial de contexto pós-clone. */
  firstBootPending?: boolean
  /** Comportamento do terminal após aceitar o merge (relocalizar em nova branch ou fechar). */
  mergePostAction?: 'relocateToNewBranch' | 'relocateKeepSession' | 'closeTerminal'
  /** Worktrees com limpeza inacabada (deleção física ou `prune` falhados). */
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
  /** URL de imagem pequena pra usar como ícone do grupo no lugar do bullet colorido. */
  iconUrl?: string
  collapsed: boolean
  /** Ordem manual dos projetos dentro do grupo. */
  projectIds: string[]
  /** v2.1 — null = grupo raiz; senão o ID do grupo pai (subgrupo). */
  parentGroupId: string | null
  /** v2.2 — modo de layout pros projetos quando o grupo é o "ativo" da workspace. */
  layoutMode?: LayoutMode
  /** Definição do grid quando layoutMode === 'grid'. */
  gridLayout?: GridLayout
  /** v2.3 — grupo suspenso: todos os terminais ficam disabled e containers fechados pra liberar RAM. */
  suspended?: boolean
  /** Grupo preservado, mas oculto da sidebar até ser restaurado em Configurações. */
  archived?: boolean
  createdAt: number
}

/** Estado de um projeto aberto na workspace. 1:1 com Project enquanto existe. */
export type WorkspaceContainer = {
  projectId: string
  /** Panes (terminais) visíveis nesse container. Ordem = posição dos panes. */
  paneIds: string[]
  /** Última vez que esse container/projeto foi aberto/focado. Usado nas tabs da topbar. */
  lastUsedAt?: number
  /** Proporção (0..1) entre containers no eixo externo. Defaults serão recalculados se 0. */
  size: number
  internalLayout: LayoutMode
  collapsed: boolean
}

export type WorkspaceRecentTab = {
  kind: 'project' | 'group'
  id: string
}

export type WorkspaceTabKind = 'project' | 'group' | 'terminal' | 'composition'

/** Estado visual restaurável. PTYs e conteúdo dos terminais permanecem globais. */
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
  /** Tab fixada — não é evictada pelo limite e fica antes das demais. */
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

export type Preferences = {
  /** Idioma da UI. Default 'en'. */
  language: Locale
  uiTheme: Theme
  /** Native desktop icon theme. Defaults to Dark independently from the UI theme. */
  appIconTheme: AppIconTheme
  /** Zoom global da WebView. 1 = 100%. */
  uiZoom: number
  /** Opacidade da janela nativa. 1 = totalmente opaca. */
  windowOpacity: number
  terminalTheme: Theme | null
  enabledAgents: Record<AgentType, boolean>
  onboardingDone: boolean
  /** v2 — modo flat ignora os containers e mostra panes soltos como antes. */
  workspaceFlat: boolean
  /** v2 — projeto-container que está em fullscreen na workspace. */
  fullscreenContainerId: string | null
  /**
   * Isola UM terminal específico dentro do fullscreen de container acima —
   * `ProjectContainer` mostra só essa pane em vez da grade inteira, mas
   * continua sendo o MESMO fullscreen de sempre (Sidebar de Projetos e
   * gaveta GSD Sync continuam visíveis). Só faz sentido junto de
   * `fullscreenContainerId` setado; sempre limpo junto dele. Acionado pela
   * gaveta GSD Sync (o único jeito de ver a pane "GSD Sync" — ela nunca
   * entra na grade normal do projeto).
   */
  isolatedPaneId: string | null
  /** Timestamp da primeira abertura do app (pra contagem de dias no welcome). */
  firstLaunchAt: number | null
  /** Nome exibido no welcome modal. */
  displayName: string
  /** URL da foto de perfil escolhida no cadastro local. */
  profileImageUrl: string
  /** True quando o cadastro local de perfil foi concluido. */
  accountCreated: boolean
  /** Se true, abre na Home mesmo se havia projeto ativo na última sessão. */
  alwaysStartOnHome: boolean
  /** Se true, novos terminais começam com o modo irrestrito ativado. */
  alwaysStartUnrestricted: boolean
  /** Organização visual da faixa superior. */
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
  /** Maximum number of authenticated LAN remote devices. Default 1. */
  remoteMaxDevices: number
  /** Remote session lifetime in seconds. Default 1 hour. */
  remoteSessionExpirySecs: number
  /** Módulos opcionais habilitados para este perfil. */
  enabledFeatures: Record<FeatureId, boolean>
  /** Folder configured as the base location for the global Todo list. */
  todoStoragePath: string
  /** Estado persistente do shell principal. */
  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  leftSidebarWidth: number
  rightSidebarWidth: number
  /**
   * Posição das barras divisórias entre painéis, por grupo de painéis
   * (`groupId` → `panelId` → porcentagem 0..100). Guardado em proporção, não em
   * pixels, pra fazer sentido em janelas de tamanhos diferentes — é o que
   * permite o Desktop e o Web mostrarem o mesmo arranjo de painéis.
   */
  paneLayouts?: Record<string, Record<string, number>>
  /** Notifica quando uma janela de uso do Claude/Codex reseta, indicando qual. Default true. */
  notifyOnLimitReset: boolean
  /** Ditado por voz (speech-to-text) escreve no terminal ativo. Default false. */
  dictationEnabled: boolean
  /** Quantos PTYs podem ser spawnados em paralelo (fila global). Default 3. */
  spawnConcurrency: number
  /** Limites de RAM e política de estacionamento automático dos runtimes. */
  resourcePolicy: ResourcePolicyPreferences
  /** v2.2 — grid layout custom da workspace inteira (cross-grupo). */
  workspaceGridLayout?: GridLayout
  /**
   * v2.4 — backend de terminal nativo (libghostty) no macOS. Opt-in.
   * Só tem efeito no macOS; Windows/Linux ignoram e seguem no xterm.js.
   * Default false até a feature sair do estágio experimental.
   */
  nativeTerminalMacos?: boolean
  /**
   * v3 — perfil de heap do Node.js para agentes (Claude, Codex, OpenCode).
   * Injeta --max-old-space-size e UV_THREADPOOL_SIZE no ambiente do PTY.
   */
  nodeHeapProfile?: 'conservative' | 'balanced' | 'performance'
  /**
   * Cadeia de fallback de modelos (ids do provider `opencode`) pra sessão-
   * filha do GSD Sync — tentados em ordem, automaticamente, APÓS o modelo
   * que a sessão principal acabou de usar (sempre tentado primeiro,
   * implícito, nunca precisa estar nesta lista). Vazio (default) = sem rede
   * de segurança configurada.
   */
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
  version: 6
  groups: Group[]
  /** Ordem manual dos projetos sem grupo (Solto). */
  ungroupedOrder: string[]
  projects: Project[]
  /** Lista pessoal global, independente do projeto ativo. */
  todos: TodoItem[]
  activeProjectId: string | null
  /** Estado da workspace — quais containers estão abertos e em que ordem. */
  workspace: {
    containers: WorkspaceContainer[]
    /** Projetos acessados recentemente, mais recente primeiro, para tabs rápidas da topbar. */
    recentProjectIds: string[]
    /** Tabs recentes da topbar, com escopo de projeto ou grupo/subgrupo. */
    recentTabs: WorkspaceRecentTab[]
    /** Tabs restauráveis da workspace. */
    tabs: WorkspaceTab[]
    /** Pilha das tabs removidas da topbar, da mais recente para a mais antiga. */
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
  uiTheme: 'dark',
  appIconTheme: 'dark',
  uiZoom: 1,
  windowOpacity: 1,
  terminalTheme: null,
  enabledAgents: {
    shell: true,
    claude: true,
    codex: true,
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
  topbarStyle: 'classic',
  gitControlPlacement: 'left',
  spotifyClientId: '',
  spotifyClientSecret: '',
  discordRichPresenceEnabled: true,
  topbarShowClaudeUsage: true,
  topbarShowCodexUsage: true,
  topbarShowAntigravityUsage: true,
  topbarShowSync: true,
  topbarShowProfile: true,
  topbarShowMemory: true,
  remoteMaxDevices: 1,
  remoteSessionExpirySecs: 3600,
  enabledFeatures: { todos: true, git: true, browser: true, graphify: true, aiMemory: false },
  todoStoragePath: '',
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
  version: 6,
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

/** Status runtime de um PTY (não persistido). */
export type PtyStatus = 'working' | 'waiting' | 'stopped' | 'disabled' | 'offline'

/** Cores predefinidas pra grupos e projetos. */
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

/** Catálogo de modelos suportados por provedor/CLI. */
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

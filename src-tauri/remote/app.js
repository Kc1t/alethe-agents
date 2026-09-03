const app = document.querySelector('#app')
const params = new URLSearchParams(location.search)
const pairingToken = params.get('pair') || ''
const httpBase = location.origin
const SESSION_KEY = 'alethe.remote.session'
const FONT_SIZE_KEY = 'alethe.remote.fontSize'
const CHAT_VIEW_KEY = 'alethe.remote.chatView'
const TRANSCRIPT_POLL_MS = 4000
const APPEARANCE_SYNC_MS = 10_000
const FONT_SIZE_MIN = 7
const FONT_SIZE_MAX = 22
const DEFAULT_PTY_SIZE = { cols: 80, rows: 24 }

const messages = {
  en: {
    'brand.remote': 'Alethe Remote',
    'common.back': 'Back',
    'common.details': 'Technical details',
    'common.reload': 'Try again',
    'common.terminal': 'Terminal',
    'connection.connecting': 'Connecting',
    'connection.live': 'Live',
    'connection.reconnecting': 'Reconnecting',
    'device.browser': 'Browser',
    'device.mobile': 'Mobile device',
    'home.activeChats': '{count} available chat',
    'home.activeChatsPlural': '{count} available chats',
    'home.chatCount': '{count} chat',
    'home.chatCountPlural': '{count} chats',
    'home.description': 'Choose a shared terminal and continue your work from this device.',
    'home.emptyDescription': 'Open a terminal in Alethe or allow remote access to an existing one.',
    'home.emptyTitle': 'No shared chats yet',
    'home.noMatchesDescription': 'Try a project, group, agent, or terminal name.',
    'home.noMatchesTitle': 'No matching chats',
    'home.openChat': 'Open {name}',
    'home.projectCount': '{count} project',
    'home.projectCountPlural': '{count} projects',
    'home.remoteAccess': 'Available remotely',
    'home.search': 'Search projects, groups, or agents',
    'home.title': 'Continue where you left off',
    'home.ungrouped': 'Ungrouped',
    'home.workspace': 'Workspace',
    'chat.context': '{project} · {agent}',
    'chat.emptyTerminal': 'Waiting for terminal output…',
    'chat.fitWidth': 'Fit to width',
    'chat.fontLarger': 'Increase text size',
    'chat.fontSmaller': 'Decrease text size',
    'chat.jumpLatest': 'Jump to latest',
    'chat.liveTerminal': 'Live terminal',
    'chat.messagesEmpty': 'No messages in this session yet.',
    'chat.messagesError': 'Unable to read this session: {message}',
    'chat.messagesUnsupported':
      'The message view reads the agent transcript, which only Claude Code and Codex write. Use the terminal for this one.',
    'chat.messageHint': 'Enter sends · Shift + Enter adds a line',
    'chat.readOnly': 'This device has read-only access. Sending messages is disabled in Alethe.',
    'chat.send': 'Send message',
    'chat.sendError': 'Message not sent: {message}',
    'chat.sendPlaceholder': 'Message this terminal…',
    'chat.sending': 'Sending message',
    'chat.sessionEnded': 'Terminal session ended.',
    'chat.toolResult': 'Result',
    'chat.viewMessages': 'Chat',
    'chat.viewTerminal': 'Terminal',
    'role.assistant': 'Agent',
    'role.user': 'You',
    'state.connectionDescription':
      'Alethe could not be reached on the local network. Check that the desktop app and this device are still connected to the same network.',
    'state.connectionTitle': 'Connection unavailable',
    'state.loadingDescription': 'Preparing your shared workspace…',
    'state.loadingTitle': 'Connecting to Alethe',
    'state.pairingDescription':
      'Open Remote control in Alethe and scan the QR code to connect this device.',
    'state.pairingTitle': 'Pair this device',
    'state.sessionDescription':
      'This device is no longer paired. Open Remote control in Alethe and scan a new QR code.',
    'state.sessionTitle': 'Remote session ended',
    'state.terminalError': 'Unable to load terminal output.',
  },
  'pt-BR': {
    'brand.remote': 'Alethe Remote',
    'common.back': 'Voltar',
    'common.details': 'Detalhes técnicos',
    'common.reload': 'Tentar novamente',
    'common.terminal': 'Terminal',
    'connection.connecting': 'Conectando',
    'connection.live': 'Ao vivo',
    'connection.reconnecting': 'Reconectando',
    'device.browser': 'Navegador',
    'device.mobile': 'Dispositivo móvel',
    'home.activeChats': '{count} conversa disponível',
    'home.activeChatsPlural': '{count} conversas disponíveis',
    'home.chatCount': '{count} conversa',
    'home.chatCountPlural': '{count} conversas',
    'home.description':
      'Escolha um terminal compartilhado e continue seu trabalho neste dispositivo.',
    'home.emptyDescription':
      'Abra um terminal no Alethe ou permita o acesso remoto a um terminal existente.',
    'home.emptyTitle': 'Nenhuma conversa compartilhada',
    'home.noMatchesDescription': 'Busque pelo nome de um projeto, grupo, agente ou terminal.',
    'home.noMatchesTitle': 'Nenhuma conversa encontrada',
    'home.openChat': 'Abrir {name}',
    'home.projectCount': '{count} projeto',
    'home.projectCountPlural': '{count} projetos',
    'home.remoteAccess': 'Disponível remotamente',
    'home.search': 'Buscar projetos, grupos ou agentes',
    'home.title': 'Continue de onde parou',
    'home.ungrouped': 'Sem grupo',
    'home.workspace': 'Workspace',
    'chat.context': '{project} · {agent}',
    'chat.emptyTerminal': 'Aguardando saída do terminal…',
    'chat.fitWidth': 'Ajustar à largura',
    'chat.fontLarger': 'Aumentar o texto',
    'chat.fontSmaller': 'Diminuir o texto',
    'chat.jumpLatest': 'Ir para o final',
    'chat.liveTerminal': 'Terminal ao vivo',
    'chat.messagesEmpty': 'Nenhuma mensagem nesta sessão ainda.',
    'chat.messagesError': 'Não foi possível ler esta sessão: {message}',
    'chat.messagesUnsupported':
      'A visão de mensagens lê o transcript do agente, que só o Claude Code e o Codex escrevem. Use o terminal neste aqui.',
    'chat.messageHint': 'Enter envia · Shift + Enter adiciona uma linha',
    'chat.readOnly':
      'Este dispositivo tem acesso somente leitura. O envio de mensagens está desativado no Alethe.',
    'chat.send': 'Enviar mensagem',
    'chat.sendError': 'Mensagem não enviada: {message}',
    'chat.sendPlaceholder': 'Enviar mensagem para este terminal…',
    'chat.sending': 'Enviando mensagem',
    'chat.sessionEnded': 'Sessão do terminal encerrada.',
    'chat.toolResult': 'Resultado',
    'chat.viewMessages': 'Chat',
    'chat.viewTerminal': 'Terminal',
    'role.assistant': 'Agente',
    'role.user': 'Você',
    'state.connectionDescription':
      'Não foi possível alcançar o Alethe na rede local. Confira se o app desktop e este dispositivo continuam conectados à mesma rede.',
    'state.connectionTitle': 'Conexão indisponível',
    'state.loadingDescription': 'Preparando seu workspace compartilhado…',
    'state.loadingTitle': 'Conectando ao Alethe',
    'state.pairingDescription':
      'Abra o Controle remoto no Alethe e escaneie o QR code para conectar este dispositivo.',
    'state.pairingTitle': 'Conecte este dispositivo',
    'state.sessionDescription':
      'Este dispositivo não está mais pareado. Abra o Controle remoto no Alethe e escaneie um novo QR code.',
    'state.sessionTitle': 'Sessão remota encerrada',
    'state.terminalError': 'Não foi possível carregar a saída do terminal.',
  },
}

const icons = {
  arrowDown:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m0 0 6-6m-6 6-6-6"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  fitWidth:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12m16-12v12M8 12h8m0 0-3-3m3 3-3 3"/></svg>',
  fontLarger: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  fontSmaller: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></svg>',
}

const agentLetters = {
  claude: 'C',
  codex: 'X',
  copilot: 'P',
  opencode: 'O',
  shell: '>_',
  antigravity: 'A',
  freebuff: 'F',
  mimo: 'M',
}
const agentLabels = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  shell: 'Shell',
  antigravity: 'Antigravity',
  freebuff: 'Freebuff',
  mimo: 'Mimo',
}
const agentIconAssets = {
  claude: '/assets/agents/claude.png',
  codex: '/assets/agents/codex.png',
  opencode: '/assets/agents/opencode.png',
}
const knownAgents = new Set(Object.keys(agentLetters))

let sessionToken = sessionStorage.getItem(SESSION_KEY) || ''
let wsBase = null
let readOnly = false
let state = { groups: [], projects: [] }
let selected = null
let terminal = null
let ptySize = { ...DEFAULT_PTY_SIZE }
let pendingWrites = []
let fontSize = Number(localStorage.getItem(FONT_SIZE_KEY)) || 0
let autoFitFont = !fontSize
let chatView = localStorage.getItem(CHAT_VIEW_KEY) === 'messages' ? 'messages' : 'terminal'
let transcript = null
let transcriptTimer = null
let socket = null
let socketAuthenticated = false
let reconnectTimer = null
let connectionState = 'connecting'
let currentFilter = ''
const openProjects = new Set()
let stateView = null
let appearanceSyncing = false
let rendered = false
let appearance = {
  uiTheme: 'elite-indigo',
  appIconTheme: 'elite-indigo',
  language: 'en',
  motionPreference: 'animated',
  colorScheme: 'dark',
}

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char],
  )
function t(key, replacements = {}) {
  const dictionary = messages[appearance.language] || messages.en
  const template = dictionary[key] || messages.en[key] || key
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  )
}

function plural(one, many, count) {
  return t(count === 1 ? one : many, { count })
}

function normalizedAgent(agent) {
  const type = String(agent || 'shell').toLowerCase()
  return knownAgents.has(type) ? type : 'shell'
}

function agentName(agent) {
  const type = normalizedAgent(agent)
  return agentLabels[type]
}

class SessionError extends Error {}

async function readError(response) {
  try {
    return (await response.json()).error || response.statusText
  } catch {
    return response.statusText
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${httpBase}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${sessionToken}` },
  })
  if (response.status === 401 || response.status === 429)
    throw new SessionError(await readError(response))
  if (!response.ok) throw new Error(await readError(response))
  return response.status === 204 ? null : response.json()
}

async function pair() {
  const deviceName = /Android|iPhone|iPad/i.test(navigator.userAgent)
    ? t('device.mobile')
    : t('device.browser')
  const response = await fetch(`${httpBase}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: pairingToken, deviceName }),
  })
  if (!response.ok) throw new SessionError(await readError(response))
  const paired = await response.json()
  sessionToken = paired.sessionToken
  sessionStorage.setItem(SESSION_KEY, sessionToken)
  history.replaceState(null, '', location.pathname)
}

function dropSession() {
  sessionToken = ''
  sessionStorage.removeItem(SESSION_KEY)
  if (reconnectTimer) window.clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
}

function updateThemeColor() {
  const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta && background) meta.content = background
}

function applyAppearance(next, shouldRender = true) {
  const languageChanged = next.language !== appearance.language
  const iconChanged = next.appIconTheme !== appearance.appIconTheme
  appearance = { ...appearance, ...next }
  document.documentElement.dataset.theme = appearance.uiTheme
  document.documentElement.dataset.motion = appearance.motionPreference
  document.documentElement.lang = appearance.language
  document.documentElement.style.colorScheme = appearance.colorScheme
  if (iconChanged || !document.querySelector('[data-brand-icon]')) updateBrandAssets()
  updateThemeColor()
  if (terminal) terminal.options.theme = terminalTheme()
  if (languageChanged && rendered && shouldRender) renderCurrentView()
}

function updateBrandAssets() {
  const url = `/brand-icon.png?v=${encodeURIComponent(appearance.appIconTheme)}`
  document.querySelectorAll('[data-brand-icon]').forEach((image) => {
    image.src = url
  })
  document
    .querySelectorAll('[data-brand-favicon], link[rel="apple-touch-icon"]')
    .forEach((link) => {
      link.href = url
    })
}

async function syncAppearance(shouldRender = true) {
  if (appearanceSyncing) return
  appearanceSyncing = true
  try {
    const response = await fetch('/appearance.json', { cache: 'no-store' })
    if (response.ok) applyAppearance(await response.json(), shouldRender)
  } catch {
    updateThemeColor()
  } finally {
    appearanceSyncing = false
  }
}

function startAppearanceSync() {
  window.setInterval(() => void syncAppearance(), APPEARANCE_SYNC_MS)
  window.addEventListener('focus', () => void syncAppearance())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncAppearance()
  })
}

function connectionLabel() {
  return t(`connection.${connectionState}`)
}

function setConnectionState(next) {
  connectionState = next
  document.querySelectorAll('[data-connection]').forEach((pill) => {
    pill.dataset.state = next
    const label = pill.querySelector('[data-connection-label]')
    if (label) label.textContent = connectionLabel()
  })
}

function connectionPill() {
  return `<div class="connection-pill" data-connection data-state="${connectionState}" role="status"><span class="connection-symbol" aria-hidden="true"><span class="connection-icon connection-icon-connecting"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/></svg></span><span class="connection-icon connection-icon-live"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.25 2.25L15.8 9.2"/></svg></span><span class="connection-icon connection-icon-reconnecting"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.93-3M4 4v4h4m-4 5a8 8 0 0 0 14.93 3M20 20v-4h-4"/></svg></span></span><span data-connection-label>${escapeHtml(connectionLabel())}</span></div>`
}

function brandMarkup(subtitle) {
  return `<div class="brand"><img class="brand-logo" src="/brand-icon.png?v=${encodeURIComponent(appearance.appIconTheme)}" alt="" data-brand-icon><div><strong>${t('brand.remote')}</strong><span>${escapeHtml(subtitle)}</span></div></div>`
}

function agentBadge(agent) {
  const type = normalizedAgent(agent)
  return `<span class="agent-badge" data-agent="${type}" aria-hidden="true">${escapeHtml(agentLetters[type])}</span>`
}

function agentIconMarkup(agent) {
  const type = normalizedAgent(agent)
  const asset = agentIconAssets[type]
  if (!asset) return agentBadge(agent)
  return `<img class="terminal-icon" src="${asset}" alt="" loading="lazy">`
}

function findChat(ptyId) {
  return state.projects
    .flatMap((project) =>
      (project.chats || []).map((chat) => ({ ...chat, projectName: project.name })),
    )
    .find((chat) => chat.ptyId === ptyId)
}

function workspaceSections(filter) {
  const groups = new Map((state.groups || []).map((group) => [group.id, group]))
  const query = filter.trim().toLocaleLowerCase(appearance.language)
  const projects = (state.projects || [])
    .map((project) => ({
      ...project,
      chats: (project.chats || []).filter((chat) => {
        const groupName = groups.get(project.groupId)?.name || ''
        return (
          !query ||
          `${groupName} ${project.name} ${chat.name} ${chat.agent}`
            .toLocaleLowerCase(appearance.language)
            .includes(query)
        )
      }),
    }))
    .filter((project) => project.chats.length > 0)

  if (!projects.length) {
    const hasChats = (state.projects || []).some((project) => (project.chats || []).length)
    const title = hasChats ? t('home.noMatchesTitle') : t('home.emptyTitle')
    const description = hasChats ? t('home.noMatchesDescription') : t('home.emptyDescription')
    return `<section class="empty-state"><span class="empty-icon">${icons.terminal}</span><h2>${title}</h2><p>${description}</p></section>`
  }

  const byGroup = new Map()
  for (const project of projects) {
    const key = project.groupId || '__ungrouped'
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key).push(project)
  }
  const hasQuery = Boolean(query)

  return [...byGroup.entries()]
    .map(([groupId, groupProjects]) => {
      const group = groups.get(groupId)
      return `<section class="group-block">
      <div class="group-tag"><span>${escapeHtml(group?.name || t('home.ungrouped'))}</span><span class="group-rule"></span></div>
      <div class="group-body">${groupProjects.map((project) => projectBlockMarkup(project, hasQuery)).join('')}</div>
    </section>`
    })
    .join('')
}

function projectBlockMarkup(project, forceOpen) {
  const collapsible = project.chats.length > 1
  const isOpen = !collapsible || forceOpen || openProjects.has(project.id)
  const leadStyle = project.color ? ` style="color:${escapeHtml(project.color)}"` : ''
  return `<div class="project-block">
    <div class="project-row${isOpen ? ' is-open' : ''}"${collapsible ? ` data-toggle="${escapeHtml(project.id)}"` : ''}>
      <span class="project-lead"${leadStyle}>${icons.folder}</span>
      <span class="project-name">${escapeHtml(project.name)}</span>
      <span class="project-meta">${!isOpen ? `<span class="meta-text">${plural('home.chatCount', 'home.chatCountPlural', project.chats.length)}</span>` : ''}${collapsible ? `<span class="chevron">${icons.chevronRight}</span>` : ''}</span>
    </div>
    <div class="terminal-list"${isOpen ? '' : ' hidden'}>${project.chats.map((chat) => terminalRowMarkup(chat)).join('')}</div>
  </div>`
}

function terminalRowMarkup(chat) {
  return `<button class="terminal-row" type="button" data-chat="${escapeHtml(chat.ptyId)}" aria-label="${escapeHtml(t('home.openChat', { name: chat.name }))}">
    <span class="terminal-lead">${agentIconMarkup(chat.agent)}</span>
    <span class="terminal-name">${escapeHtml(chat.name)}</span>
    <span class="terminal-tag">${escapeHtml(agentName(chat.agent))}</span>
    <span class="row-icon">${icons.chevronRight}</span>
  </button>`
}

function renderWorkspaceList(filter) {
  currentFilter = filter
  const list = document.querySelector('#workspace-list')
  if (!list) return
  list.innerHTML = workspaceSections(filter)
  list
    .querySelectorAll('[data-chat]')
    .forEach((button) => button.addEventListener('click', () => void openChat(button.dataset.chat)))
  list.querySelectorAll('[data-toggle]').forEach((row) =>
    row.addEventListener('click', () => {
      const id = row.dataset.toggle
      if (openProjects.has(id)) openProjects.delete(id)
      else openProjects.add(id)
      renderWorkspaceList(currentFilter)
    }),
  )
}

function renderHome(filter = currentFilter) {
  stateView = null
  selected = null
  disposeTerminal()
  stopTranscriptPolling()
  const chatCount = (state.projects || []).reduce(
    (total, project) => total + (project.chats || []).length,
    0,
  )
  app.innerHTML = `<div class="app-frame">
    <header class="topbar">${brandMarkup(t('home.workspace'))}${connectionPill()}</header>
    <main class="page home-page">
      <section class="home-intro"><div><h1>${t('home.title')}</h1><p>${t('home.description')}</p></div><span class="chat-total">${plural('home.activeChats', 'home.activeChatsPlural', chatCount)}</span></section>
      <label class="search-field">${icons.search}<span class="sr-only">${t('home.search')}</span><input id="search" value="${escapeHtml(filter)}" placeholder="${t('home.search')}" autocomplete="off"></label>
      <div id="workspace-list"></div>
    </main>
  </div>`
  rendered = true
  updateBrandAssets()
  renderWorkspaceList(filter)
  const search = document.querySelector('#search')
  search.addEventListener('input', (event) => renderWorkspaceList(event.target.value))
  setConnectionState(connectionState)
}

const LIGHT_ANSI = {
  black: '#1f2328',
  red: '#c0392b',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#3f3f46',
  brightBlack: '#6e7781',
  brightRed: '#cf222e',
  brightGreen: '#1a7f37',
  brightYellow: '#bf8700',
  brightBlue: '#0969da',
  brightMagenta: '#8250df',
  brightCyan: '#1b7c83',
  brightWhite: '#18181b',
}

function readToken(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function terminalTheme() {
  const base = {
    background: readToken('--bg-sunken', '#101114'),
    foreground: readToken('--fg', '#f3f4f6'),
    cursor: readToken('--accent', '#f3f4f6'),
    cursorAccent: readToken('--bg-sunken', '#101114'),
    selectionBackground: readToken('--accent-ring', 'rgba(59,130,246,0.4)'),
  }
  return appearance.colorScheme === 'light' ? { ...base, ...LIGHT_ANSI } : base
}

function disposeTerminal() {
  if (terminal) terminal.dispose()
  terminal = null
  pendingWrites = []
}

function mountTerminal() {
  const host = document.querySelector('#terminal-host')
  if (!host || !window.Terminal) return
  const instance = new window.Terminal({
    cols: ptySize.cols,
    rows: ptySize.rows,
    scrollback: 5000,
    disableStdin: true,
    cursorBlink: false,
    convertEol: false,
    allowProposedApi: true,
    fontFamily: readToken('--font-mono', 'monospace'),
    fontSize: fontSize || 12,
    theme: terminalTheme(),
  })
  const unicode = window.Unicode11Addon?.Unicode11Addon
  if (unicode) {
    instance.loadAddon(new unicode())
    instance.unicode.activeVersion = '11'
  }
  instance.open(host)
  const helper = host.querySelector('.xterm-helper-textarea')
  if (helper) {
    helper.setAttribute('readonly', 'readonly')
    helper.setAttribute('inputmode', 'none')
  }
  instance.onScroll(() => updateJumpButton())
  terminal = instance
  if (pendingWrites.length) {
    instance.write(pendingWrites.join(''))
    pendingWrites = []
  }
  applyTerminalFit()
  scheduleTerminalFit()
}

function cellMetrics() {
  const screen = document.querySelector('#terminal-host .xterm-screen')
  if (!screen || !terminal || !terminal.cols || !terminal.rows) return null
  const width = screen.clientWidth / terminal.cols
  const height = screen.clientHeight / terminal.rows
  return width > 0 && height > 0 ? { width, height } : null
}

function applyTerminalFit() {
  if (!terminal) return
  const viewport = document.querySelector('#terminal-viewport')
  if (!viewport) return
  const available = viewport.clientWidth
  const availableHeight = viewport.clientHeight
  if (available <= 0) return
  const metrics = cellMetrics()
  const widthRatio = metrics ? metrics.width / terminal.options.fontSize : 0.6
  const heightRatio = metrics ? metrics.height / terminal.options.fontSize : 1.2
  if (autoFitFont) {
    const target = Math.floor(available / (ptySize.cols * widthRatio))
    fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, target))
  }
  if (!fontSize) fontSize = 12
  if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize
  const visibleRows = Math.floor(availableHeight / (fontSize * heightRatio))
  const rows = Math.max(ptySize.rows, Math.min(visibleRows || ptySize.rows, 200))
  if (terminal.cols !== ptySize.cols || terminal.rows !== rows) terminal.resize(ptySize.cols, rows)
  updateJumpButton()
}

function scheduleTerminalFit() {
  window.requestAnimationFrame(() => applyTerminalFit())
}

function setFontSize(next) {
  autoFitFont = false
  fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(next)))
  localStorage.setItem(FONT_SIZE_KEY, String(fontSize))
  applyTerminalFit()
}

function enableAutoFit() {
  autoFitFont = true
  localStorage.removeItem(FONT_SIZE_KEY)
  applyTerminalFit()
}

function setPtySize(cols, rows) {
  const nextCols = Number(cols) || ptySize.cols
  const nextRows = Number(rows) || ptySize.rows
  if (nextCols === ptySize.cols && nextRows === ptySize.rows) return
  ptySize = { cols: nextCols, rows: nextRows }
  applyTerminalFit()
}

function writeTerminal(text) {
  if (!text) return
  if (!terminal) {
    pendingWrites.push(text)
    return
  }
  terminal.write(text)
}

function resetTerminal(text) {
  const content = text || `\u001b[2m${t('chat.emptyTerminal')}\u001b[0m`
  if (!terminal) {
    pendingWrites = [content]
    return
  }
  terminal.reset()
  terminal.write(content)
  terminal.scrollToBottom()
}

function terminalIsAtBottom() {
  if (!terminal) return true
  const buffer = terminal.buffer.active
  return buffer.viewportY >= buffer.baseY
}

function updateJumpButton() {
  const latest = document.querySelector('#latest')
  if (latest) latest.hidden = terminalIsAtBottom()
}

function scrollTerminalToEnd() {
  if (terminal) terminal.scrollToBottom()
  updateJumpButton()
}

function bindTerminalGestures() {
  const viewport = document.querySelector('#terminal-viewport')
  if (!viewport) return
  let pinchStart = 0
  let pinchFont = 0
  const distance = (touches) =>
    Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
  viewport.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 2) return
      pinchStart = distance(event.touches)
      pinchFont = fontSize || 12
    },
    { passive: true },
  )
  viewport.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length !== 2 || !pinchStart) return
      event.preventDefault()
      setFontSize(pinchFont * (distance(event.touches) / pinchStart))
    },
    { passive: false },
  )
  viewport.addEventListener('touchend', () => {
    pinchStart = 0
  })
}

function subscribeSocket(ptyId) {
  if (socket?.readyState !== WebSocket.OPEN || !socketAuthenticated) return false
  socket.send(JSON.stringify({ type: 'subscribe', sessionToken, ptyId }))
  return true
}

async function loadScrollback(ptyId) {
  if (subscribeSocket(ptyId)) return
  try {
    const data = await api(`/api/scrollback?id=${encodeURIComponent(ptyId)}`)
    if (ptyId !== selected) return
    setPtySize(data.cols, data.rows)
    resetTerminal(data.text || '')
  } catch (error) {
    if (error instanceof SessionError) {
      renderSessionLost(error.message)
      return
    }
    resetTerminal(`${t('state.terminalError')}\r\n${error.message || error}\r\n`)
  }
}

function inlineMarkdown(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function renderMarkdown(text) {
  return String(text ?? '')
    .split('```')
    .map((part, index) => {
      if (index % 2 === 1) {
        const body = part.replace(/^[\w-]*\n/, '').replace(/\n$/, '')
        return `<pre class="msg-code">${escapeHtml(body)}</pre>`
      }
      return part
        .split(/\n{2,}/)
        .filter((block) => block.trim())
        .map((block) => `<p>${inlineMarkdown(escapeHtml(block)).replaceAll('\n', '<br>')}</p>`)
        .join('')
    })
    .join('')
}

function toolSummary(text) {
  const value = String(text ?? '')
  const separator = value.indexOf(':')
  const name = separator > 0 && separator < 40 ? value.slice(0, separator) : t('chat.toolResult')
  return { name, body: separator > 0 && separator < 40 ? value.slice(separator + 1).trim() : value }
}

function messageMarkup(message) {
  const role = message.role
  if (role === 'tool' || role === 'tool-result') {
    const { name, body } = toolSummary(message.text)
    return `<details class="msg-step" data-role="${escapeHtml(role)}">
      <summary>${escapeHtml(role === 'tool' ? name : t('chat.toolResult'))}</summary>
      <pre>${escapeHtml(body)}</pre>
    </details>`
  }
  return `<article class="msg" data-role="${escapeHtml(role)}">
    <span class="msg-role">${escapeHtml(role === 'user' ? t('role.user') : transcript?.agent ? agentName(transcript.agent) : t('role.assistant'))}</span>
    <div class="msg-body">${renderMarkdown(message.text)}</div>
  </article>`
}

function transcriptNotice(text) {
  return `<p class="messages-notice">${escapeHtml(text)}</p>`
}

function renderTranscript() {
  const list = document.querySelector('#messages')
  if (!list) return
  if (!transcript) return
  if (transcript.supported === false) {
    list.innerHTML = transcriptNotice(t('chat.messagesUnsupported'))
    return
  }
  if (transcript.error) {
    list.innerHTML = transcriptNotice(t('chat.messagesError', { message: transcript.error }))
    return
  }
  const messages = transcript.messages || []
  if (!messages.length) {
    list.innerHTML = transcriptNotice(t('chat.messagesEmpty'))
    return
  }
  const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 120
  list.innerHTML = messages.map(messageMarkup).join('')
  if (nearEnd) list.scrollTop = list.scrollHeight
}

async function loadTranscript(ptyId) {
  const since = transcript?.revision ? `&since=${transcript.revision}` : ''
  try {
    const data = await api(`/api/transcript?id=${encodeURIComponent(ptyId)}${since}`)
    if (ptyId !== selected) return
    if (data.unchanged) return
    transcript = data
    renderTranscript()
  } catch (error) {
    if (error instanceof SessionError) {
      renderSessionLost(error.message)
      return
    }
    if (ptyId !== selected) return
    transcript = { supported: true, error: error.message || String(error) }
    renderTranscript()
  }
}

function stopTranscriptPolling() {
  if (transcriptTimer) window.clearInterval(transcriptTimer)
  transcriptTimer = null
}

function startTranscriptPolling() {
  stopTranscriptPolling()
  const ptyId = selected
  void loadTranscript(ptyId)
  transcriptTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible' || chatView !== 'messages') return
    void loadTranscript(ptyId)
  }, TRANSCRIPT_POLL_MS)
}

function setChatView(next) {
  if (chatView === next) return
  chatView = next
  localStorage.setItem(CHAT_VIEW_KEY, next)
  renderChat()
}

function composerMarkup() {
  if (readOnly)
    return `<aside class="read-only-notice">${icons.info}<p>${t('chat.readOnly')}</p></aside>`
  return `<div class="composer-wrap"><form class="composer" id="composer">
    <label class="sr-only" for="message">${t('chat.sendPlaceholder')}</label><textarea id="message" rows="1" autocomplete="off" placeholder="${t('chat.sendPlaceholder')}"></textarea>
    <button class="send-button" type="submit" aria-label="${t('chat.send')}"><span class="send-icon">${icons.send}</span><span class="send-loader" aria-hidden="true"></span></button>
    <p class="composer-error" id="composer-error" role="alert"></p><p class="composer-hint">${t('chat.messageHint')}</p>
  </form></div>`
}

function viewSwitchMarkup() {
  const option = (view, label) =>
    `<button type="button" data-view="${view}"${chatView === view ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>${escapeHtml(label)}</button>`
  return `<div class="view-switch" role="group">${option('terminal', t('chat.viewTerminal'))}${option('messages', t('chat.viewMessages'))}</div>`
}

function terminalPaneMarkup() {
  return `<div class="terminal-tools">
      <button class="icon-button tool-button" id="font-smaller" type="button" aria-label="${t('chat.fontSmaller')}">${icons.fontSmaller}</button>
      <button class="icon-button tool-button" id="font-larger" type="button" aria-label="${t('chat.fontLarger')}">${icons.fontLarger}</button>
      <button class="icon-button tool-button" id="font-fit" type="button" aria-label="${t('chat.fitWidth')}">${icons.fitWidth}</button>
    </div>
  </header>
  <div class="terminal-viewport" id="terminal-viewport"><div class="terminal-host" id="terminal-host"></div></div>
  <button class="jump-latest" id="latest" type="button" hidden>${icons.arrowDown}<span>${t('chat.jumpLatest')}</span></button>`
}

function messagesPaneMarkup() {
  return `</header>
  <div class="messages" id="messages"><p class="messages-notice">${t('state.loadingDescription')}</p></div>`
}

function renderChat() {
  const chat = findChat(selected)
  if (!chat) {
    selected = null
    renderHome()
    return
  }
  stateView = null
  disposeTerminal()
  stopTranscriptPolling()
  const showTerminal = chatView === 'terminal'
  app.innerHTML = `<div class="app-frame chat-frame">
    <header class="topbar chat-topbar"><button class="icon-button back-button" id="back" type="button" aria-label="${t('common.back')}">${icons.arrowLeft}</button><div class="chat-title"><strong>${escapeHtml(chat.name)}</strong><span>${escapeHtml(t('chat.context', { project: chat.projectName || t('home.workspace'), agent: agentName(chat.agent) }))}</span></div>${connectionPill()}</header>
    <main class="page chat-page"><section class="terminal-shell" data-view="${showTerminal ? 'terminal' : 'messages'}">
      <header class="terminal-heading">${viewSwitchMarkup()}
      ${showTerminal ? terminalPaneMarkup() : messagesPaneMarkup()}
    </section>${composerMarkup()}</main>
  </div>`
  rendered = true
  document.querySelector('#back').addEventListener('click', () => {
    disposeTerminal()
    stopTranscriptPolling()
    renderHome()
  })
  app
    .querySelectorAll('.view-switch [data-view]')
    .forEach((button) => button.addEventListener('click', () => setChatView(button.dataset.view)))
  if (!readOnly) bindComposer()
  setConnectionState(connectionState)
  if (showTerminal) {
    document.querySelector('#latest').addEventListener('click', () => scrollTerminalToEnd())
    document
      .querySelector('#font-smaller')
      .addEventListener('click', () => setFontSize((fontSize || 12) - 1))
    document
      .querySelector('#font-larger')
      .addEventListener('click', () => setFontSize((fontSize || 12) + 1))
    document.querySelector('#font-fit').addEventListener('click', () => enableAutoFit())
    mountTerminal()
    bindTerminalGestures()
    void loadScrollback(selected)
    return
  }
  renderTranscript()
  startTranscriptPolling()
}

function bindComposer() {
  const form = document.querySelector('#composer')
  const input = document.querySelector('#message')
  const button = form.querySelector('.send-button')
  const errorLabel = document.querySelector('#composer-error')
  const autoGrow = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`
  }
  input.addEventListener('input', () => {
    errorLabel.textContent = ''
    autoGrow()
  })
  input.addEventListener('focus', () => {
    window.scrollTo(0, 0)
    window.requestAnimationFrame(() => scrollTerminalToEnd())
  })
  autoGrow()
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.disabled = true
    button.disabled = true
    button.classList.add('is-loading')
    button.setAttribute('aria-label', t('chat.sending'))
    try {
      await api('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ptyId: selected, text }),
      })
      input.value = ''
      autoGrow()
    } catch (error) {
      if (error instanceof SessionError) {
        renderSessionLost(error.message)
        return
      }
      errorLabel.textContent = t('chat.sendError', { message: error.message || error })
    } finally {
      if (input.isConnected) {
        input.disabled = false
        button.disabled = false
        button.classList.remove('is-loading')
        button.setAttribute('aria-label', t('chat.send'))
        input.focus()
      }
    }
  })
}

function openChat(ptyId) {
  selected = ptyId
  ptySize = { ...DEFAULT_PTY_SIZE }
  transcript = null
  renderChat()
}
function connectSocket() {
  if (!wsBase || !sessionToken) return
  setConnectionState('connecting')
  socket = new WebSocket(`${wsBase}/`)
  socket.onopen = () => {
    socketAuthenticated = false
    socket.send(
      JSON.stringify({
        type: 'hello',
        sessionToken,
        deviceName: /Android|iPhone|iPad/i.test(navigator.userAgent)
          ? t('device.mobile')
          : t('device.browser'),
      }),
    )
  }
  socket.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.type === 'authenticated') {
      socketAuthenticated = true
      setConnectionState('live')
      if (selected) subscribeSocket(selected)
      return
    }
    if (message.type === 'error') {
      if (message.reason === 'expired' || message.reason === 'unauthorized') {
        renderSessionLost(message.message)
        return
      }
      setConnectionState('reconnecting')
      return
    }
    if (message.ptyId !== selected) return
    if (message.type === 'scrollback') {
      setPtySize(message.cols, message.rows)
      if (chatView === 'terminal') resetTerminal(message.text || '')
      return
    }
    if (message.type === 'pty_resize') {
      setPtySize(message.cols, message.rows)
      return
    }
    if (message.type === 'pty_output') {
      if (chatView !== 'terminal') return
      const stick = terminalIsAtBottom()
      writeTerminal(message.text || '')
      if (stick) scrollTerminalToEnd()
      else updateJumpButton()
      return
    }
    if (message.type === 'pty_exit')
      writeTerminal(`\r\n\u001b[2m${t('chat.sessionEnded')}\u001b[0m\r\n`)
  }
  socket.onclose = () => {
    socketAuthenticated = false
    setConnectionState('reconnecting')
    reconnectTimer = window.setTimeout(connectSocket, 1500)
  }
  socket.onerror = () => setConnectionState('reconnecting')
}

function renderState(config) {
  const { titleKey, descriptionKey, detail = '', action = false, loading = false } = config
  stateView = config
  disposeTerminal()
  stopTranscriptPolling()
  app.innerHTML = `<div class="state-page ${loading ? 'is-loading' : ''}" role="status" aria-live="polite"><div class="state-content"><img class="state-logo" src="/brand-icon.png?v=${encodeURIComponent(appearance.appIconTheme)}" alt="" data-brand-icon><span class="state-brand">${t('brand.remote')}</span><h1>${t(titleKey)}</h1><p>${t(descriptionKey)}</p>${detail ? `<details><summary>${t('common.details')}</summary><code>${escapeHtml(detail)}</code></details>` : ''}${action ? `<button class="primary-button" id="state-action" type="button">${icons.refresh}<span>${t('common.reload')}</span></button>` : ''}<span class="loading-track" aria-hidden="true"></span></div></div>`
  rendered = true
  if (action)
    document.querySelector('#state-action').addEventListener('click', () => location.reload())
}

function renderLoading() {
  renderState({
    titleKey: 'state.loadingTitle',
    descriptionKey: 'state.loadingDescription',
    loading: true,
  })
}

function renderPairingRequired(message) {
  renderState({
    titleKey: 'state.pairingTitle',
    descriptionKey: 'state.pairingDescription',
    detail: message,
    action: Boolean(pairingToken),
  })
}

function renderSessionLost(message) {
  dropSession()
  renderState({
    titleKey: 'state.sessionTitle',
    descriptionKey: 'state.sessionDescription',
    detail: message,
  })
}

function renderConnectionUnavailable(message) {
  renderState({
    titleKey: 'state.connectionTitle',
    descriptionKey: 'state.connectionDescription',
    detail: message,
    action: true,
  })
}

function renderCurrentView() {
  if (stateView) renderState(stateView)
  else if (selected) renderChat()
  else if (state.projects.length || sessionToken) renderHome(currentFilter)
}

function syncViewportMetrics() {
  const viewport = window.visualViewport
  const root = document.documentElement
  const height = Math.round(viewport ? viewport.height : window.innerHeight)
  const offset = Math.round(viewport ? viewport.offsetTop : 0)
  root.style.setProperty('--app-height', `${height}px`)
  root.style.setProperty('--viewport-offset', `${offset}px`)
  scheduleTerminalFit()
}

function startViewportSync() {
  const viewport = window.visualViewport
  syncViewportMetrics()
  if (viewport) {
    viewport.addEventListener('resize', syncViewportMetrics)
    viewport.addEventListener('scroll', syncViewportMetrics)
  }
  window.addEventListener('resize', syncViewportMetrics)
  window.addEventListener('orientationchange', () => window.setTimeout(syncViewportMetrics, 150))
}

async function boot() {
  await syncAppearance(false)
  startAppearanceSync()
  startViewportSync()
  renderLoading()
  if (pairingToken) {
    try {
      await pair()
    } catch (error) {
      renderPairingRequired(error.message)
      return
    }
  }
  if (!sessionToken) {
    renderPairingRequired()
    return
  }
  try {
    const info = await api('/api/info')
    wsBase = info.wsUrl
    readOnly = info.readOnly === true
    state = await api('/api/state')
    renderHome()
    connectSocket()
  } catch (error) {
    if (error instanceof SessionError) {
      renderSessionLost(error.message)
      return
    }
    renderConnectionUnavailable(error.message || error)
  }
}

void boot()

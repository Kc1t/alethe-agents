import { messages } from './locales.js'

const app = document.querySelector('#app')
const params = new URLSearchParams(location.search)
const pairingToken = params.get('pair') || ''
const httpBase = location.origin
const SESSION_KEY = 'alethe.remote.session'
const FONT_SIZE_KEY = 'alethe.remote.fontSize'
const CHAT_VIEW_KEY = 'alethe.remote.chatView'
const DRAFTS_KEY = 'alethe.remote.drafts.v1'
const TRANSCRIPT_POLL_MS = 1500
const APPEARANCE_SYNC_MS = 10_000
const WORKSPACE_SYNC_MS = 5_000
const FONT_SIZE_MIN = 7
const FONT_SIZE_MAX = 22
const DEFAULT_PTY_SIZE = { cols: 80, rows: 24 }
const MAX_SAVED_DRAFTS = 20
const MAX_DRAFT_LENGTH = 8_000

const icons = {
  arrowDown:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m0 0 6-6m-6 6-6-6"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
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
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></svg>',
}

const agentLetters = {
  claude: 'C',
  codex: 'X',
  copilot: 'P',
  cursor: 'CU',
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
  cursor: 'Cursor',
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
let chatView = localStorage.getItem(CHAT_VIEW_KEY) === 'terminal' ? 'terminal' : 'messages'
let transcript = null
let transcriptTimer = null
let transcriptRequest = null
let transcriptError = ''
const chatSessions = new Map()

function savedDrafts() {
  try {
    const value = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function persistDraft(ptyId, draft) {
  if (!ptyId) return
  const drafts = Object.assign(Object.create(null), savedDrafts())
  delete drafts[ptyId]
  if (draft) drafts[ptyId] = String(draft).slice(0, MAX_DRAFT_LENGTH)
  const trimmed = Object.fromEntries(Object.entries(drafts).slice(-MAX_SAVED_DRAFTS))
  try {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(trimmed))
  } catch {
    // The in-memory draft remains available when browser storage is full or disabled.
  }
}

function chatSession(ptyId = selected) {
  if (!chatSessions.has(ptyId)) {
    const drafts = savedDrafts()
    chatSessions.set(ptyId, {
      draft: Object.prototype.hasOwnProperty.call(drafts, ptyId)
        ? String(drafts[ptyId]).slice(0, MAX_DRAFT_LENGTH)
        : '',
      sending: false,
      error: '',
      pending: [],
      waitingSince: 0,
      waitingForAssistantAfter: null,
      answeredQuestionRevision: null,
      controlNotice: '',
      needsAnswer: false,
      ended: false,
    })
  }
  return chatSessions.get(ptyId)
}

function supportsMessages(ptyId = selected) {
  return ['claude', 'codex'].includes(findChat(ptyId)?.agent)
}
let socket = null
let socketAuthenticated = false
let reconnectTimer = null
let reconnectAttempt = 0
let workspaceSyncing = false
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
  if (response.status === 401) throw new SessionError(await readError(response))
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

function reconnectDelay() {
  return Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4))
}

function scheduleReconnect(immediate = false) {
  if (!sessionToken || reconnectTimer) return
  const delay = immediate ? 0 : reconnectDelay()
  reconnectAttempt += 1
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connectSocket()
  }, delay)
}

async function refreshWorkspace() {
  if (!sessionToken || workspaceSyncing || document.visibilityState === 'hidden') return
  workspaceSyncing = true
  try {
    const next = await api('/api/state')
    state = next
    if (selected && !findChat(selected)) {
      selected = null
      renderHome()
    } else if (!selected) renderWorkspaceList(currentFilter)
  } catch (error) {
    if (error instanceof SessionError) renderSessionLost(error.message)
  } finally {
    workspaceSyncing = false
  }
}

function startRemoteLifecycle() {
  window.setInterval(() => void refreshWorkspace(), WORKSPACE_SYNC_MS)
  window.addEventListener('online', () => {
    setConnectionState('connecting')
    scheduleReconnect(true)
    void refreshWorkspace()
  })
  window.addEventListener('offline', () => setConnectionState('reconnecting'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void refreshWorkspace()
    if (selected && chatView === 'messages') void loadTranscript(selected)
    if (!socket || socket.readyState > WebSocket.OPEN) scheduleReconnect(true)
  })
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
  updateChatFeedback()
  updateComposer()
  updateQuestionControls()
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
  const session = chatSession(chat.ptyId)
  const status = session.ended
    ? 'ended'
    : session.needsAnswer
      ? 'question'
      : session.waitingSince
        ? 'working'
        : session.draft
          ? 'draft'
          : ''
  const statusMarkup = status
    ? `<span class="terminal-status" data-status="${status}"><i aria-hidden="true"></i>${t(`home.status.${status}`)}</span>`
    : `<span class="terminal-tag">${escapeHtml(agentName(chat.agent))}</span>`
  return `<button class="terminal-row" type="button" data-chat="${escapeHtml(chat.ptyId)}" aria-label="${escapeHtml(t('home.openChat', { name: chat.name }))}">
    <span class="terminal-lead">${agentIconMarkup(chat.agent)}</span>
    <span class="terminal-name">${escapeHtml(chat.name)}</span>
    ${statusMarkup}
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
      const lines = part.split('\n')
      const blocks = []
      let listType = ''
      const closeList = () => {
        if (listType) blocks.push(`</${listType}>`)
        listType = ''
      }
      for (const line of lines) {
        const item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/)
        if (item) {
          const type = item[1] ? 'ul' : 'ol'
          if (type !== listType) {
            closeList()
            blocks.push(`<${type}>`)
            listType = type
          }
          blocks.push(`<li>${inlineMarkdown(escapeHtml(item[2]))}</li>`)
          continue
        }
        closeList()
        if (!line.trim()) continue
        const heading = line.match(/^(#{1,6})\s+(.+)$/)
        if (heading) {
          const tag = heading[1].length < 3 ? 'h3' : 'h4'
          blocks.push(`<${tag}>${inlineMarkdown(escapeHtml(heading[2]))}</${tag}>`)
        } else if (line.startsWith('> ')) {
          blocks.push(`<blockquote>${inlineMarkdown(escapeHtml(line.slice(2)))}</blockquote>`)
        } else blocks.push(`<p>${inlineMarkdown(escapeHtml(line))}</p>`)
      }
      closeList()
      return blocks.join('')
    })
    .join('')
}

function toolSummary(text) {
  const value = String(text ?? '')
  const separator = value.indexOf(':')
  const name = separator > 0 && separator < 40 ? value.slice(0, separator) : t('chat.toolResult')
  return { name, body: separator > 0 && separator < 40 ? value.slice(separator + 1).trim() : value }
}

function isActiveQuestion(message, index, messages) {
  if (message.role !== 'question' || !message.questions?.length) return false
  if (chatSession().answeredQuestionRevision === transcript?.revision) return false
  return !messages
    .slice(index + 1)
    .some((next) => ['user', 'assistant', 'tool-result', 'question'].includes(next.role))
}

function questionMarkup(message, index, messages) {
  const active = isActiveQuestion(message, index, messages)
  const interactive = active && !readOnly
  const questions = message.questions || []
  const fields = questions
    .map((question, questionIndex) => {
      const type = question.multiSelect ? 'checkbox' : 'radio'
      const options = question.options
        .map((option, optionIndex) => {
          const control = interactive
            ? `<input data-option type="${type}" name="question-${index}-${questionIndex}" value="${optionIndex}">`
            : ''
          return `<label class="question-option${interactive ? '' : ' is-static'}">${control}<span class="question-option-copy"><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span></label>`
        })
        .join('')
      const custom = interactive
        ? `<label class="question-option question-option-custom"><input data-custom-toggle type="${type}" name="question-${index}-${questionIndex}" value="custom"><span class="question-option-copy"><strong>${t('question.other')}</strong><input class="question-custom-input" data-custom-input type="text" maxlength="1000" disabled placeholder="${t('question.otherPlaceholder')}"></span></label>`
        : ''
      return `<fieldset data-question-index="${questionIndex}" data-multi="${String(!!question.multiSelect)}"><legend>${escapeHtml(question.header || t('question.title'))}</legend><p class="question-copy">${escapeHtml(question.question)}</p><div class="question-options">${options}${custom}</div>${question.multiSelect && interactive ? `<small class="question-multiple">${t('question.multiple')}</small>` : ''}</fieldset>`
    })
    .join('')
  const footer = interactive
    ? `<div class="question-actions"><p role="alert" data-question-error></p><button type="submit" disabled><span>${t('question.submit')}</span><i class="chat-spinner" aria-hidden="true"></i></button></div>`
    : `<p class="question-resolved">${t(active && readOnly ? 'question.readOnly' : 'question.answered')}</p>`
  return `<article class="question-card" data-role="question"><form data-question-form data-question-set-id="${escapeHtml(message.questionSetId || '')}" data-message-index="${index}">${fields}${footer}</form></article>`
}

function messageMarkup(message, index, messages) {
  const role = message.role
  if (role === 'question') return questionMarkup(message, index, messages)
  if (role === 'tool' || role === 'tool-result') {
    const { name, body } = toolSummary(message.text)
    return `<details class="msg-step" data-role="${escapeHtml(role)}">
      <summary>${escapeHtml(role === 'tool' ? name : t('chat.toolResult'))}</summary>
      <pre>${escapeHtml(body)}</pre>
    </details>`
  }
  return `<article class="msg" data-role="${escapeHtml(role)}">
    <div class="msg-heading"><span class="msg-role">${escapeHtml(role === 'user' ? t('role.user') : transcript?.agent ? agentName(transcript.agent) : t('role.assistant'))}</span><button class="copy-message" type="button" data-copy-message="${index}" aria-label="${escapeHtml(t('chat.copy'))}">${icons.copy}<span>${escapeHtml(t('chat.copy'))}</span></button></div>
    <div class="msg-body">${renderMarkdown(message.text)}</div>
  </article>`
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // LAN pages may not receive the secure-context Clipboard API; use the selection fallback.
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.className = 'clipboard-fallback'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand?.('copy') === true
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

function bindMessageActions(messages) {
  document.querySelectorAll('[data-copy-message]').forEach((button) => {
    button.addEventListener('click', async () => {
      const message = messages[Number(button.dataset.copyMessage)]
      if (!message) return
      const copied = await copyText(String(message.text || ''))
      const resultKey = copied ? 'chat.copied' : 'chat.copyFailed'
      button.classList.add(copied ? 'is-copied' : 'is-copy-error')
      button.querySelector('span').textContent = t(resultKey)
      button.setAttribute('aria-label', t(resultKey))
      window.setTimeout(() => {
        if (!button.isConnected) return
        button.classList.remove('is-copied', 'is-copy-error')
        button.querySelector('span').textContent = t('chat.copy')
        button.setAttribute('aria-label', t('chat.copy'))
      }, 1_500)
    })
  })
}

function transcriptNotice(text) {
  return `<p class="messages-notice">${escapeHtml(text)}</p>`
}

function pendingMarkup() {
  return chatSession()
    .pending.filter((item) => !item.confirmed)
    .map(
      (item) =>
        `<article class="msg msg-pending" data-role="user"><span class="msg-role">${t('role.user')} · ${t(item.sending ? 'chat.sending' : 'chat.sent')}</span><div class="msg-body">${renderMarkdown(item.text)}</div></article>`,
    )
    .join('')
}

function renderTranscript() {
  const list = document.querySelector('#messages')
  if (!list) return
  updateChatFeedback()
  if (!transcript) {
    list.innerHTML =
      (transcriptError
        ? transcriptNotice(t('chat.loadFailed'))
        : `<div class="chat-loading" role="status"><span class="chat-spinner" aria-hidden="true"></span><p>${t('chat.loading')}</p><div class="chat-skeleton" aria-hidden="true"><i></i><i></i><i></i></div></div>`) +
      pendingMarkup()
    list.setAttribute('aria-busy', String(!transcriptError))
    return
  }
  list.setAttribute('aria-busy', 'false')
  if (transcript.supported === false) {
    list.innerHTML = transcriptNotice(t('chat.messagesUnsupported'))
    return
  }
  const messages = transcript.messages || []
  const markup = messages.map(messageMarkup).join('') + pendingMarkup()
  const content =
    markup ||
    `<div class="messages-empty"><strong>${t('chat.emptyTitle', { agent: agentName(findChat(selected)?.agent) })}</strong><p>${t(readOnly ? 'chat.messagesEmpty' : 'chat.emptyHint')}</p></div>`
  if (list.dataset.content === content) return
  const nearEnd =
    !list.dataset.content || list.scrollHeight - list.scrollTop - list.clientHeight < 120
  const scrollTop = list.scrollTop
  const expanded = [...list.querySelectorAll('.msg-step')].map((node) => node.open)
  list.innerHTML = content
  list.dataset.content = content
  list.querySelectorAll('.msg-step').forEach((node, index) => {
    node.open = expanded[index] || false
  })
  bindQuestionCards()
  bindMessageActions(messages)
  if (nearEnd) list.scrollTop = list.scrollHeight
  else list.scrollTop = scrollTop
  updateMessagesJump()
}

async function loadTranscript(ptyId) {
  if (ptyId !== selected || chatView !== 'messages' || transcriptRequest) return
  const request = new AbortController()
  transcriptRequest = request
  const timeout = window.setTimeout(() => request.abort(), 12_000)
  const since = transcript?.revision ? `&since=${transcript.revision}` : ''
  try {
    const data = await api(`/api/transcript?id=${encodeURIComponent(ptyId)}${since}`, {
      signal: request.signal,
    })
    if (ptyId !== selected || transcriptRequest !== request) return
    if (data.error) throw new Error(data.error)
    transcriptError = ''
    if (data.unchanged) return
    const previousRevision = transcript?.revision
    transcript = data
    const session = chatSession(ptyId)
    const lastConversation = [...(data.messages || [])]
      .reverse()
      .find((message) => ['user', 'assistant', 'question'].includes(message.role))
    if (!session.waitingSince && lastConversation?.role === 'user')
      session.waitingSince = Date.now()
    const lastQuestionIndex = (data.messages || [])
      .map((message) => message.role)
      .lastIndexOf('question')
    session.needsAnswer =
      lastQuestionIndex >= 0 &&
      session.answeredQuestionRevision !== data.revision &&
      !data.messages
        .slice(lastQuestionIndex + 1)
        .some((message) => ['user', 'assistant', 'tool-result', 'question'].includes(message.role))
    if (session.controlNotice && data.revision !== previousRevision) session.controlNotice = ''
    if (
      session.waitingForAssistantAfter != null &&
      data.messages
        .slice(session.waitingForAssistantAfter)
        .some((message) => message.role === 'assistant')
    ) {
      session.waitingForAssistantAfter = null
      session.waitingSince = 0
    }
    for (const pending of session.pending) {
      const matches = (data.messages || [])
        .map((message, index) => ({ ...message, index }))
        .filter((message) => message.role === 'user' && message.text.trim() === pending.text)
      const match = matches[pending.occurrence]
      if (match) {
        pending.confirmed = true
        pending.answered = data.messages
          .slice(match.index + 1)
          .some((message) => message.role === 'assistant')
      }
    }
    session.pending = session.pending.filter((item) => !item.answered || item.sending)
    if (
      !session.pending.length &&
      session.waitingForAssistantAfter == null &&
      lastConversation?.role !== 'user'
    )
      session.waitingSince = 0
    renderTranscript()
  } catch (error) {
    if (ptyId !== selected || transcriptRequest !== request) return
    if (error instanceof SessionError) {
      renderSessionLost(error.message)
      return
    }
    transcriptError =
      error.name === 'AbortError' ? t('chat.loadTimeout') : error.message || String(error)
    renderTranscript()
  } finally {
    window.clearTimeout(timeout)
    if (transcriptRequest === request) transcriptRequest = null
    updateChatFeedback()
    updateComposer()
  }
}

function updateMessagesJump() {
  const list = document.querySelector('#messages')
  const button = document.querySelector('#messages-latest')
  if (list && button) button.hidden = list.scrollHeight - list.scrollTop - list.clientHeight < 120
}

function updateChatFeedback() {
  const feedback = document.querySelector('#chat-feedback')
  if (!feedback || !selected) return
  const session = chatSession()
  const slow = session.waitingSince && Date.now() - session.waitingSince > 20_000
  let key = 'chat.synced'
  if (!transcript) key = 'chat.loading'
  if (session.waitingSince) key = slow ? 'chat.waitingLong' : 'chat.waiting'
  if (session.sending) key = 'chat.sending'
  if (session.controlNotice) key = session.controlNotice
  if (connectionState !== 'live') key = 'chat.reconnecting'
  if (transcriptError) key = 'chat.loadFailed'
  if (session.ended) key = 'chat.sessionEnded'
  feedback.dataset.busy = String(
    transcript?.supported !== false &&
      !session.ended &&
      !transcriptError &&
      (session.sending || !!session.waitingSince || !transcript || connectionState !== 'live'),
  )
  feedback.querySelector('[data-feedback-text]').textContent = t(key, {
    agent: agentName(findChat(selected)?.agent),
  })
  const retry = feedback.querySelector('[data-retry]')
  retry.hidden = !transcriptError
  retry.disabled = !!transcriptRequest
  feedback.querySelector('[data-open-terminal]').hidden =
    !slow && !session.ended && transcript?.supported !== false
  const interrupt = feedback.querySelector('[data-interrupt]')
  interrupt.hidden =
    !session.waitingSince ||
    session.ended ||
    readOnly ||
    connectionState !== 'live' ||
    !supportsMessages()
  interrupt.disabled = interrupt.dataset.sending === 'true'
  const detail = feedback.querySelector('[data-feedback-detail]')
  detail.hidden = !transcriptError
  detail.querySelector('code').textContent = transcriptError
}

function bindQuestionCards() {
  document.querySelectorAll('[data-question-form]').forEach((form) => {
    const submit = form.querySelector('button[type="submit"]')
    if (!submit) return
    const fieldAnswered = (field) => {
      const customToggle = field.querySelector('[data-custom-toggle]')
      const customInput = field.querySelector('[data-custom-input]')
      return (
        !!field.querySelector('[data-option]:checked') ||
        (customToggle?.checked && !!customInput?.value.trim())
      )
    }
    const update = () => {
      submit.disabled =
        connectionState !== 'live' ||
        form.dataset.sending === 'true' ||
        [...form.querySelectorAll('fieldset')].some((field) => !fieldAnswered(field))
    }
    form.addEventListener('change', (event) => {
      const field = event.target.closest('fieldset')
      if (field) {
        const customToggle = field.querySelector('[data-custom-toggle]')
        const customInput = field.querySelector('[data-custom-input]')
        if (event.target === customToggle && customToggle.checked) {
          field.querySelectorAll('[data-option]').forEach((input) => (input.checked = false))
          customInput.disabled = false
          customInput.focus()
        } else if (event.target.matches('[data-option]') && event.target.checked) {
          customToggle.checked = false
          customInput.disabled = true
        }
      }
      update()
    })
    form.querySelectorAll('[data-custom-input]').forEach((input) =>
      input.addEventListener('input', () => {
        const toggle = input.closest('fieldset').querySelector('[data-custom-toggle]')
        if (!toggle.checked) toggle.checked = true
        update()
      }),
    )
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (submit.disabled || form.dataset.sending === 'true') return
      const ptyId = selected
      const questionSetId = form.dataset.questionSetId
      const questionRevision = transcript?.revision ?? 0
      const assistantStart = transcript?.messages?.length ?? 0
      const selections = [...form.querySelectorAll('fieldset')].map((field) =>
        [...field.querySelectorAll('[data-option]:checked')].map((input) => Number(input.value)),
      )
      const customAnswers = [...form.querySelectorAll('fieldset')].map((field) => {
        const toggle = field.querySelector('[data-custom-toggle]')
        return toggle?.checked ? field.querySelector('[data-custom-input]').value.trim() : null
      })
      form.dataset.sending = 'true'
      form.querySelectorAll('input').forEach((input) => (input.disabled = true))
      submit.disabled = true
      submit.classList.add('is-loading')
      form.querySelector('[data-question-error]').textContent = ''
      const request = new AbortController()
      const timeout = window.setTimeout(() => request.abort(), 20_000)
      try {
        await api('/api/question-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ptyId, questionSetId, selections, customAnswers }),
          signal: request.signal,
        })
        const session = chatSession(ptyId)
        session.answeredQuestionRevision = questionRevision
        session.needsAnswer = false
        session.waitingForAssistantAfter = assistantStart
        session.waitingSince = Date.now()
        if (selected === ptyId) {
          const list = document.querySelector('#messages')
          if (list) delete list.dataset.content
          renderTranscript()
          updateChatFeedback()
          void loadTranscript(ptyId)
        }
      } catch (error) {
        if (error instanceof SessionError) {
          renderSessionLost(error.message)
          return
        }
        form.dataset.sending = 'false'
        form.querySelectorAll('input').forEach((input) => (input.disabled = false))
        form.querySelectorAll('fieldset').forEach((field) => {
          const toggle = field.querySelector('[data-custom-toggle]')
          const customInput = field.querySelector('[data-custom-input]')
          if (customInput) customInput.disabled = !toggle.checked
        })
        submit.classList.remove('is-loading')
        form.querySelector('[data-question-error]').textContent = t('question.sendError', {
          message:
            error.name === 'AbortError' || error instanceof TypeError
              ? t('question.sendUncertain')
              : error.message || error,
        })
        update()
      } finally {
        window.clearTimeout(timeout)
      }
    })
    update()
  })
}

function updateQuestionControls() {
  document.querySelectorAll('[data-question-form]').forEach((form) => {
    const submit = form.querySelector('button[type="submit"]')
    if (!submit) return
    submit.disabled =
      connectionState !== 'live' ||
      form.dataset.sending === 'true' ||
      [...form.querySelectorAll('fieldset')].some((field) => {
        const customToggle = field.querySelector('[data-custom-toggle]')
        const customInput = field.querySelector('[data-custom-input]')
        return (
          !field.querySelector('[data-option]:checked') &&
          !(customToggle?.checked && customInput?.value.trim())
        )
      })
  })
}

function stopTranscriptPolling() {
  if (transcriptTimer) window.clearInterval(transcriptTimer)
  transcriptTimer = null
  transcriptRequest?.abort()
  transcriptRequest = null
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
  const placeholder = supportsMessages()
    ? t('chat.agentPlaceholder', { agent: agentName(findChat(selected)?.agent) })
    : t('chat.sendPlaceholder')
  return `<div class="composer-wrap"><form class="composer" id="composer">
    <label class="sr-only" for="message">${escapeHtml(placeholder)}</label><textarea id="message" rows="1" autocomplete="off" aria-describedby="composer-error composer-hint" placeholder="${escapeHtml(placeholder)}">${escapeHtml(chatSession().draft)}</textarea>
    <button class="send-button" type="submit" aria-label="${t('chat.send')}"><span class="send-icon">${icons.send}</span><span class="send-loader" aria-hidden="true"></span></button>
    <p class="composer-error" id="composer-error" role="alert"></p><p class="composer-hint" id="composer-hint">${t('chat.mobileHint')}</p>
  </form></div>`
}

function viewSwitchMarkup() {
  const option = (view, label) =>
    `<button type="button" data-view="${view}"${chatView === view ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>${escapeHtml(label)}</button>`
  return `<div class="view-switch" role="group" aria-label="${t('chat.viewLabel')}">${option('messages', t('chat.viewMessages'))}${option('terminal', t('chat.viewTerminal'))}</div>`
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
  <div class="chat-feedback" id="chat-feedback" data-busy="true"><div class="chat-feedback-line" role="status"><span class="chat-spinner" aria-hidden="true"></span><span data-feedback-text>${t('chat.loading')}</span></div><button class="interrupt-button" type="button" data-interrupt hidden>${icons.stop}<span>${t('chat.interrupt')}</span></button><button type="button" data-retry hidden>${t('common.reload')}</button><button type="button" data-open-terminal hidden>${t('chat.viewTerminal')}</button><details data-feedback-detail hidden><summary>${t('common.details')}</summary><code></code></details></div>
  <div class="messages" id="messages" role="region" aria-label="${t('chat.viewMessages')}" aria-busy="true"></div>
  <button class="jump-latest" id="messages-latest" type="button" hidden>${icons.arrowDown}<span>${t('chat.jumpLatest')}</span></button>`
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
  subscribeSocket(selected)
  document
    .querySelector('#messages')
    .addEventListener('scroll', updateMessagesJump, { passive: true })
  document.querySelector('#messages-latest').addEventListener('click', () => {
    const list = document.querySelector('#messages')
    list.scrollTop = list.scrollHeight
    updateMessagesJump()
  })
  document.querySelector('[data-retry]').addEventListener('click', () => {
    void loadTranscript(selected)
    updateChatFeedback()
  })
  document
    .querySelector('[data-open-terminal]')
    .addEventListener('click', () => setChatView('terminal'))
  document.querySelector('[data-interrupt]').addEventListener('click', async (event) => {
    const button = event.currentTarget
    const ptyId = selected
    const session = chatSession(ptyId)
    if (button.dataset.sending === 'true' || connectionState !== 'live') return
    button.dataset.sending = 'true'
    updateChatFeedback()
    try {
      await api('/api/agent-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ptyId, action: 'interrupt' }),
      })
      session.waitingSince = 0
      session.waitingForAssistantAfter = null
      session.controlNotice = 'chat.interruptSent'
    } catch (error) {
      if (error instanceof SessionError) {
        renderSessionLost(error.message)
        return
      }
      session.error = t('chat.interruptError', { message: error.message || error })
      updateComposer()
    } finally {
      button.dataset.sending = 'false'
      if (selected === ptyId) updateChatFeedback()
    }
  })
  startTranscriptPolling()
}

function updateComposer() {
  const form = document.querySelector('#composer')
  if (!form || !selected) return
  const session = chatSession()
  const input = form.querySelector('#message')
  const button = form.querySelector('.send-button')
  input.readOnly = session.sending || session.ended
  button.disabled =
    session.sending ||
    session.ended ||
    connectionState !== 'live' ||
    !input.value.trim() ||
    (chatView === 'messages' && supportsMessages() && !transcript)
  button.classList.toggle('is-loading', session.sending)
  button.setAttribute('aria-label', t(session.sending ? 'chat.sending' : 'chat.send'))
  form.setAttribute('aria-busy', String(session.sending))
  form.querySelector('#composer-error').textContent = session.error
}

function bindComposer() {
  const form = document.querySelector('#composer')
  const input = document.querySelector('#message')
  const ptyId = selected
  const session = chatSession(ptyId)
  const autoGrow = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`
  }
  input.addEventListener('input', () => {
    session.draft = input.value
    persistDraft(ptyId, session.draft)
    session.error = ''
    updateComposer()
    autoGrow()
  })
  input.addEventListener('focus', () => {
    window.scrollTo(0, 0)
    window.requestAnimationFrame(() => scrollTerminalToEnd())
  })
  autoGrow()
  updateComposer()
  input.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      !window.matchMedia('(pointer: coarse)').matches
    ) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (
      !text ||
      session.sending ||
      session.ended ||
      connectionState !== 'live' ||
      (chatView === 'messages' && supportsMessages() && !transcript)
    )
      return
    session.sending = true
    session.error = ''
    const pending = {
      text,
      sending: true,
      occurrence:
        (transcript?.messages || []).filter(
          (message) => message.role === 'user' && message.text.trim() === text,
        ).length + session.pending.filter((item) => item.text === text && !item.confirmed).length,
    }
    if (supportsMessages(ptyId)) session.pending.push(pending)
    updateComposer()
    renderTranscript()
    const request = new AbortController()
    const timeout = window.setTimeout(() => request.abort(), 20_000)
    try {
      await api('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ptyId, text }),
        signal: request.signal,
      })
      pending.sending = false
      session.pending = session.pending.filter((item) => !item.answered)
      session.waitingSince = session.pending.length ? Date.now() : 0
      session.draft = ''
      persistDraft(ptyId, '')
      if (selected === ptyId) {
        const currentInput = document.querySelector('#message')
        if (currentInput) {
          currentInput.value = ''
          currentInput.style.height = 'auto'
        }
        void loadTranscript(ptyId)
      }
    } catch (error) {
      session.pending = session.pending.filter((item) => item !== pending)
      if (error instanceof SessionError) {
        renderSessionLost(error.message)
        return
      }
      session.error =
        error.name === 'AbortError' || error instanceof TypeError
          ? t('chat.sendUncertain')
          : t('chat.sendError', { message: error.message || error })
    } finally {
      window.clearTimeout(timeout)
      session.sending = false
      if (selected === ptyId) {
        updateComposer()
        renderTranscript()
      }
    }
  })
}

function openChat(ptyId) {
  selected = ptyId
  ptySize = { ...DEFAULT_PTY_SIZE }
  transcript = null
  transcriptError = ''
  chatView =
    supportsMessages(ptyId) && localStorage.getItem(CHAT_VIEW_KEY) !== 'terminal'
      ? 'messages'
      : 'terminal'
  renderChat()
}
function connectSocket() {
  if (!wsBase || !sessionToken) return
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  )
    return
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
      reconnectAttempt = 0
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
    if (message.type === 'pty_exit') {
      chatSession().ended = true
      updateChatFeedback()
      updateComposer()
      writeTerminal(`\r\n\u001b[2m${t('chat.sessionEnded')}\u001b[0m\r\n`)
    }
  }
  socket.onclose = () => {
    socketAuthenticated = false
    socket = null
    setConnectionState('reconnecting')
    scheduleReconnect()
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
  startRemoteLifecycle()
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

const app = document.querySelector('#app')
const params = new URLSearchParams(location.search)
const pairingToken = params.get('pair') || ''
const httpBase = location.origin
const SESSION_KEY = 'alethe.remote.session'
const APPEARANCE_SYNC_MS = 10_000

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
    'chat.jumpLatest': 'Jump to latest',
    'chat.liveTerminal': 'Live terminal',
    'chat.messageHint': 'Enter sends · Shift + Enter adds a line',
    'chat.readOnly': 'This device has read-only access. Sending messages is disabled in Alethe.',
    'chat.send': 'Send message',
    'chat.sendError': 'Message not sent: {message}',
    'chat.sendPlaceholder': 'Message this terminal…',
    'chat.sending': 'Sending message',
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
    'chat.jumpLatest': 'Ir para o final',
    'chat.liveTerminal': 'Terminal ao vivo',
    'chat.messageHint': 'Enter envia · Shift + Enter adiciona uma linha',
    'chat.readOnly':
      'Este dispositivo tem acesso somente leitura. O envio de mensagens está desativado no Alethe.',
    'chat.send': 'Enviar mensagem',
    'chat.sendError': 'Mensagem não enviada: {message}',
    'chat.sendPlaceholder': 'Enviar mensagem para este terminal…',
    'chat.sending': 'Enviando mensagem',
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
const knownAgents = new Set(Object.keys(agentLetters))
const groupColorNames = {
  '#f97316': 'orange',
  '#ec4899': 'pink',
  '#8b5cf6': 'purple',
  '#0ea5e9': 'blue',
  '#14b8a6': 'teal',
  '#84cc16': 'green',
  '#eab308': 'yellow',
  '#ef4444': 'red',
  '#64748b': 'gray',
  '#0a0a0a': 'black',
}

let sessionToken = sessionStorage.getItem(SESSION_KEY) || ''
let wsBase = null
let readOnly = false
let state = { groups: [], projects: [] }
let selected = null
let output = ''
let socket = null
let socketAuthenticated = false
let reconnectTimer = null
let connectionState = 'connecting'
let currentFilter = ''
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
const initials = (value) =>
  String(value || 'A')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
const readableTerminalText = (value) =>
  String(value ?? '')
    .replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0008+/g, '')
    .replace(/\n{4,}/g, '\n\n\n')

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

function groupColor(color) {
  return groupColorNames[String(color || '').toLowerCase()] || 'accent'
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

  return [...byGroup.entries()]
    .map(([groupId, groupProjects]) => {
      const group = groups.get(groupId)
      const projectCount = groupProjects.length
      return `<section class="group-section" data-color="${groupColor(group?.color)}">
      <header class="group-heading"><span class="group-dot"></span><h2>${escapeHtml(group?.name || t('home.ungrouped'))}</h2><span>${plural('home.projectCount', 'home.projectCountPlural', projectCount)}</span></header>
      <div class="project-list">${groupProjects
        .map(
          (project) => `<article class="project">
        <header class="project-heading"><span class="project-avatar">${escapeHtml(initials(project.name))}</span><h3>${escapeHtml(project.name)}</h3><span>${plural('home.chatCount', 'home.chatCountPlural', project.chats.length)}</span></header>
        <div class="chat-list">${project.chats
          .map(
            (
              chat,
            ) => `<button class="chat-row" type="button" data-chat="${escapeHtml(chat.ptyId)}" aria-label="${escapeHtml(t('home.openChat', { name: chat.name }))}">
          ${agentBadge(chat.agent)}<span class="chat-copy"><strong>${escapeHtml(chat.name)}</strong><span>${escapeHtml(agentName(chat.agent))} · ${t('home.remoteAccess')}</span></span><span class="row-icon">${icons.chevronRight}</span>
        </button>`,
          )
          .join('')}</div>
      </article>`,
        )
        .join('')}</div>
    </section>`
    })
    .join('')
}

function renderWorkspaceList(filter) {
  currentFilter = filter
  const list = document.querySelector('#workspace-list')
  if (!list) return
  list.innerHTML = workspaceSections(filter)
  list
    .querySelectorAll('[data-chat]')
    .forEach((button) => button.addEventListener('click', () => void openChat(button.dataset.chat)))
}

function renderHome(filter = currentFilter) {
  stateView = null
  selected = null
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

function composerMarkup() {
  if (readOnly)
    return `<aside class="read-only-notice">${icons.info}<p>${t('chat.readOnly')}</p></aside>`
  return `<div class="composer-wrap"><form class="composer" id="composer">
    <label class="sr-only" for="message">${t('chat.sendPlaceholder')}</label><textarea id="message" rows="1" autocomplete="off" placeholder="${t('chat.sendPlaceholder')}"></textarea>
    <button class="send-button" type="submit" aria-label="${t('chat.send')}"><span class="send-icon">${icons.send}</span><span class="send-loader" aria-hidden="true"></span></button>
    <p class="composer-error" id="composer-error" role="alert"></p><p class="composer-hint">${t('chat.messageHint')}</p>
  </form></div>`
}

function renderChat() {
  const chat = findChat(selected)
  if (!chat) {
    selected = null
    renderHome()
    return
  }
  stateView = null
  app.innerHTML = `<div class="app-frame chat-frame">
    <header class="topbar chat-topbar"><button class="icon-button back-button" id="back" type="button" aria-label="${t('common.back')}">${icons.arrowLeft}</button><div class="chat-title"><strong>${escapeHtml(chat.name)}</strong><span>${escapeHtml(t('chat.context', { project: chat.projectName || t('home.workspace'), agent: agentName(chat.agent) }))}</span></div>${connectionPill()}</header>
    <main class="page chat-page"><section class="terminal-shell"><header class="terminal-heading"><span class="terminal-title">${icons.terminal}<strong>${t('chat.liveTerminal')}</strong></span><button class="text-button" id="latest" type="button" hidden>${icons.arrowDown}<span>${t('chat.jumpLatest')}</span></button></header>
      <div class="terminal-viewport"><pre class="terminal-output" id="terminal" tabindex="0"></pre><p class="terminal-empty" id="terminal-empty">${t('chat.emptyTerminal')}</p></div>
    </section>${composerMarkup()}</main>
  </div>`
  rendered = true
  document.querySelector('#back').addEventListener('click', () => renderHome())
  document.querySelector('#latest').addEventListener('click', () => scrollTerminalToEnd())
  if (!readOnly) bindComposer()
  updateTerminal(output, true)
  setConnectionState(connectionState)
}

function bindComposer() {
  const form = document.querySelector('#composer')
  const input = document.querySelector('#message')
  const button = form.querySelector('.send-button')
  const errorLabel = document.querySelector('#composer-error')
  input.addEventListener('input', () => {
    errorLabel.textContent = ''
  })
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

function updateTerminal(nextOutput, forceEnd = false) {
  const terminal = document.querySelector('#terminal')
  if (!terminal) return
  const nearEnd = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 56
  terminal.textContent = nextOutput
  const empty = document.querySelector('#terminal-empty')
  if (empty) empty.hidden = Boolean(nextOutput)
  if (forceEnd || nearEnd) scrollTerminalToEnd()
  else {
    const latest = document.querySelector('#latest')
    if (latest) latest.hidden = false
  }
}

function scrollTerminalToEnd() {
  const terminal = document.querySelector('#terminal')
  if (terminal) terminal.scrollTop = terminal.scrollHeight
  const latest = document.querySelector('#latest')
  if (latest) latest.hidden = true
}

async function openChat(ptyId) {
  selected = ptyId
  output = ''
  renderChat()
  try {
    const data = await api(`/api/scrollback?id=${encodeURIComponent(ptyId)}`)
    output = readableTerminalText(data.text || '')
    updateTerminal(output, true)
  } catch (error) {
    if (error instanceof SessionError) {
      renderSessionLost(error.message)
      return
    }
    output = `${t('state.terminalError')}\n${error.message || error}`
    updateTerminal(output, true)
  }
  if (socket?.readyState === WebSocket.OPEN && socketAuthenticated)
    socket.send(JSON.stringify({ type: 'subscribe', sessionToken, ptyId }))
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
      if (selected)
        socket.send(JSON.stringify({ type: 'subscribe', sessionToken, ptyId: selected }))
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
    if (message.type === 'scrollback') output = readableTerminalText(message.text || '')
    if (message.type === 'pty_output') output = readableTerminalText(output + (message.text || ''))
    updateTerminal(output)
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

async function boot() {
  await syncAppearance(false)
  startAppearanceSync()
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

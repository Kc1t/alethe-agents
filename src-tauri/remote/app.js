const app = document.querySelector('#app')
const params = new URLSearchParams(location.search)
const token = params.get('token') || ''
const httpBase = location.origin
let wsBase = null
let state = { groups: [], projects: [] }
let selected = null
let output = ''
let socket = null
let socketAuthenticated = false
let connectionState = 'connecting'

const agentColors = {
  claude: '#f0a15d',
  codex: '#6ed8e7',
  opencode: '#bd93f9',
  shell: '#61d095',
  antigravity: '#7aa2ff',
  freebuff: '#b19aff',
  mimo: '#f1b35a',
}
const agentLetters = {
  claude: 'C',
  codex: 'X',
  opencode: 'O',
  shell: '>_',
  antigravity: 'A',
  freebuff: 'F',
  mimo: 'M',
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

const api = async (path, options = {}) => {
  const response = await fetch(
    `${httpBase}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
    options,
  )
  if (!response.ok) throw new Error(await response.text())
  return response.status === 204 ? null : response.json()
}

function setConnectionState(next) {
  connectionState = next
  const pill = document.querySelector('[data-connection]')
  if (!pill) return
  pill.dataset.state =
    next === 'live' ? 'live' : next === 'reconnecting' ? 'reconnecting' : 'connecting'
  const label = pill.querySelector('[data-connection-label]')
  if (label)
    label.textContent =
      next === 'live' ? 'Live' : next === 'reconnecting' ? 'Reconnecting' : 'Connecting'
}

function connectionPill() {
  const label =
    connectionState === 'live'
      ? 'Live'
      : connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting'
  return `<div class="live-pill" data-connection data-state="${connectionState}"><span class="live-dot"></span><span data-connection-label>${label}</span></div>`
}

function agentBadge(agent) {
  const type = String(agent || 'shell').toLowerCase()
  return `<span class="agent-badge" style="--agent-color:${agentColors[type] || '#7aa2ff'}">${escapeHtml(agentLetters[type] || type.slice(0, 1).toUpperCase())}</span>`
}

function findChat(ptyId) {
  return state.projects
    .flatMap((project) =>
      (project.chats || []).map((chat) => ({ ...chat, projectName: project.name })),
    )
    .find((chat) => chat.ptyId === ptyId)
}

function renderHome(filter = '') {
  const groups = new Map((state.groups || []).map((group) => [group.id, group]))
  const query = filter.trim().toLowerCase()
  const projects = (state.projects || [])
    .map((project) => ({
      ...project,
      chats: (project.chats || []).filter(
        (chat) =>
          !query || `${project.name} ${chat.name} ${chat.agent}`.toLowerCase().includes(query),
      ),
    }))
    .filter((project) => project.chats.length || !query)
  const byGroup = new Map()
  for (const project of projects) {
    const key = project.groupId || '__ungrouped'
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key).push(project)
  }
  const chatCount = (state.projects || []).reduce(
    (total, project) => total + (project.chats || []).length,
    0,
  )
  const sections = [...byGroup.entries()]
    .map(([groupId, groupProjects]) => {
      const group = groups.get(groupId)
      const color = group?.color || '#7aa2ff'
      return `<section class="group"><div class="group-heading" style="--group-color:${escapeHtml(color)}"><span class="group-line"></span><h3>${escapeHtml(group?.name || 'Ungrouped')}</h3><span>${groupProjects.length} project${groupProjects.length === 1 ? '' : 's'}</span></div>${groupProjects.map((project) => `<article class="project-card"><div class="project-head"><span class="project-avatar">${escapeHtml(initials(project.name))}</span><span class="project-name">${escapeHtml(project.name)}</span><span class="project-count">${project.chats.length} chat${project.chats.length === 1 ? '' : 's'}</span></div><div class="chat-list">${project.chats.map((chat) => `<button class="chat" data-chat="${escapeHtml(chat.ptyId)}">${agentBadge(chat.agent)}<span class="chat-copy"><span class="chat-name">${escapeHtml(chat.name)}</span><span class="chat-meta"><span>${escapeHtml(chat.agent || 'Terminal')}</span><span>·</span><span>Ready to talk</span></span></span><span class="chat-arrow">›</span></button>`).join('')}</div></article>`).join('')}</section>`
    })
    .join('')
  app.innerHTML = `<div class="app-frame"><header class="topbar"><span class="brand-mark">›_</span><div class="brand-copy"><span class="eyebrow">Alethe remote</span><h1>Workspace</h1></div>${connectionPill()}</header><main class="scroll"><section class="welcome"><div><span class="eyebrow">Remote workspace</span><h2>Choose an agent</h2><p>Continue a conversation from any group on your desktop.</p></div><div class="summary"><strong>${chatCount}</strong><span>active chats</span></div></section><label class="search"><span class="search-icon">⌕</span><input id="search" value="${escapeHtml(filter)}" placeholder="Search projects or agents" autocomplete="off" /></label><div id="workspace-list">${sections || '<div class="empty">No chats match this search.</div>'}</div></main></div>`
  document
    .querySelector('#search')
    .addEventListener('input', (event) => renderHome(event.target.value))
  document
    .querySelectorAll('[data-chat]')
    .forEach((button) => button.addEventListener('click', () => openChat(button.dataset.chat)))
  setConnectionState(connectionState)
}

function renderChat() {
  const chat = findChat(selected)
  app.innerHTML = `<div class="app-frame"><header class="topbar chat-topbar"><button class="back" id="back" aria-label="Back">‹</button><div class="chat-topcopy"><span class="eyebrow">Agent conversation</span><h1>${escapeHtml(chat?.name || 'Agent chat')}</h1><p>${escapeHtml(chat?.projectName || '')} · ${escapeHtml(chat?.agent || 'Terminal')}</p></div>${agentBadge(chat?.agent)}</header><main class="scroll chat-content"><div class="context"><span>${escapeHtml(chat?.projectName || 'Workspace')}</span><span class="context-separator">/</span><span>${escapeHtml(chat?.agent || 'Terminal')}</span></div><section class="output-card"><div class="output-head"><span class="terminal-dot"></span><strong>Live terminal</strong><button id="latest" type="button">Jump to latest</button></div><pre class="terminal" id="terminal">${escapeHtml(output)}</pre></section><div class="notice">Your message is sent to the selected PTY with Enter.</div><form class="composer" id="composer"><textarea id="message" rows="1" autocomplete="off" placeholder="Send a message…"></textarea><button class="send" type="submit" aria-label="Send message">↑</button></form></main></div>`
  document.querySelector('#back').addEventListener('click', () => {
    selected = null
    renderHome()
  })
  document.querySelector('#latest').addEventListener('click', () => {
    const terminal = document.querySelector('#terminal')
    if (terminal) terminal.scrollTop = terminal.scrollHeight
  })
  const input = document.querySelector('#message')
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      document.querySelector('#composer').requestSubmit()
    }
  })
  document.querySelector('#composer').addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.disabled = true
    try {
      await api('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ptyId: selected, text }),
      })
      input.value = ''
      input.style.height = 'auto'
    } catch (error) {
      window.alert(error.message || error)
    }
    input.disabled = false
    input.focus()
  })
  const terminal = document.querySelector('#terminal')
  if (terminal) terminal.scrollTop = terminal.scrollHeight
  setConnectionState(connectionState)
}

async function openChat(ptyId) {
  selected = ptyId
  output = ''
  renderChat()
  try {
    const data = await api(`/api/scrollback?id=${encodeURIComponent(ptyId)}`)
    output = readableTerminalText(data.text || '')
    const terminal = document.querySelector('#terminal')
    if (terminal) {
      terminal.textContent = output
      terminal.scrollTop = terminal.scrollHeight
    }
  } catch (error) {
    output = `Unable to load terminal output.\n${error.message || error}`
    const terminal = document.querySelector('#terminal')
    if (terminal) terminal.textContent = output
  }
  if (socket?.readyState === WebSocket.OPEN && socketAuthenticated)
    socket.send(JSON.stringify({ type: 'subscribe', token, ptyId }))
}

function connectSocket() {
  if (!wsBase) return
  setConnectionState('connecting')
  socket = new WebSocket(`${wsBase}/?token=${encodeURIComponent(token)}`)
  socket.onopen = () => {
    setConnectionState('live')
    socketAuthenticated = false
    socket.send(
      JSON.stringify({
        type: 'hello',
        token,
        deviceName: /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Mobile device' : 'Browser',
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
      if (selected) socket.send(JSON.stringify({ type: 'subscribe', token, ptyId: selected }))
      return
    }
    if (message.type === 'error') {
      setConnectionState('reconnecting')
      return
    }
    if (message.ptyId !== selected) return
    if (message.type === 'scrollback') output = readableTerminalText(message.text || '')
    if (message.type === 'pty_output') output = readableTerminalText(output + (message.text || ''))
    const terminal = document.querySelector('#terminal')
    if (terminal) {
      terminal.textContent = output
      terminal.scrollTop = terminal.scrollHeight
    }
  }
  socket.onclose = () => {
    socketAuthenticated = false
    setConnectionState('reconnecting')
    window.setTimeout(connectSocket, 1500)
  }
  socket.onerror = () => setConnectionState('reconnecting')
}

async function boot() {
  if (!token) {
    app.innerHTML =
      '<div class="fatal"><div class="fatal-card"><span class="brand-mark">›_</span><strong>Pairing link required</strong><p>Scan the QR code shown in Alethe to connect this device.</p></div></div>'
    return
  }
  app.innerHTML =
    '<div class="loading"><div class="loading-card"><span class="brand-mark">›_</span><strong>Connecting to Alethe</strong><p>Preparing your remote workspace…</p></div></div>'
  try {
    const info = await api('/api/info')
    wsBase = info.ws_url
    state = await api('/api/state')
    renderHome()
    connectSocket()
  } catch (error) {
    app.innerHTML = `<div class="fatal"><div class="fatal-card"><span class="brand-mark">!</span><strong>Connection unavailable</strong><p>${escapeHtml(error.message || error)}</p></div></div>`
  }
}

boot()

import './bootstrap'

import './styles/reset.css'
import './styles/theme.css'
import './styles/visual-clean.css'

import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import { installDebugTrace } from './lib/debugTrace'
import { installE2eHooks } from './lib/e2eHooks'
import { initUrlRouter } from './lib/router/urlRouter'
import { recordFrontendError } from './lib/tauri'

// Inicializa os hooks de automação E2E imediatamente no startup
installE2eHooks()

// Mirrors devtools console output to logs/frontend.log for live debugging.
installDebugTrace()

// Inicializa a sincronização de rotas de URL via HTML5 History API quando executado em ambiente Web.
// No modo desktop (Tauri), as rotas funcionam por navegação interna sem sobrescrever a URL local.
initUrlRouter()

// Capture uncaught errors that React boundaries cannot handle, such as PTY callbacks.
let lastErrorAt = 0
let lastErrorKey = ''
function captureGlobalError(message: string, stack: string | null, kind: string) {
  const now = Date.now()
  const key = `${kind}:${message}`
  if (key === lastErrorKey && now - lastErrorAt < 2000) return
  lastErrorKey = key
  lastErrorAt = now
  void recordFrontendError(message, stack, kind)
}

window.addEventListener('error', (event) => {
  const source = String(event.filename || (event.error as Error | undefined)?.stack || '')
  const msg = String(event.message || '')
  if (
    source.includes('chrome-extension') ||
    source.includes('cuponomia') ||
    source.includes('spa-maker') ||
    msg.includes('cuponomia') ||
    msg.includes('tabs:outgoing')
  ) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  if (import.meta.env.DEV) console.error('[Alethe][window.error]', event.error ?? event.message)
  captureGlobalError(
    event.message || String(event.error ?? 'unknown error'),
    (event.error as Error | undefined)?.stack ?? null,
    'window.error',
  )
})

window.addEventListener('unhandledrejection', (event) => {
  const reasonStr = String(
    (event.reason as { stack?: string; message?: string })?.stack ||
      (event.reason as { stack?: string; message?: string })?.message ||
      event.reason ||
      '',
  )
  if (
    reasonStr.includes('chrome-extension') ||
    reasonStr.includes('cuponomia') ||
    reasonStr.includes('spa-maker') ||
    reasonStr.includes('wrapper-cuponomia') ||
    reasonStr.includes('outgoing.message.ready')
  ) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  if (import.meta.env.DEV) console.error('[Alethe][unhandledrejection]', event.reason)
  const reason = event.reason as { message?: string; stack?: string } | undefined
  captureGlobalError(
    reason?.message ?? String(event.reason),
    reason?.stack ?? null,
    'unhandledrejection',
  )
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

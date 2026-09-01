import './bootstrap'
import './styles/reset.css'
import './styles/theme.css'
import './styles/visual-clean.css'

import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import { recordFrontendError } from './lib/tauri'

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
  if (import.meta.env.DEV) console.error('[Alethe][window.error]', event.error ?? event.message)
  captureGlobalError(
    event.message || String(event.error ?? 'unknown error'),
    (event.error as Error | undefined)?.stack ?? null,
    'window.error',
  )
})

window.addEventListener('unhandledrejection', (event) => {
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

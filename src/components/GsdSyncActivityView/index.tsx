import { Bot, Loader2, User, Wrench, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useOnEscape } from '../../hooks/useOnEscape'
import { useT } from '../../lib/i18n'
import {
  type OpenCodeExportMessage,
  type OpenCodeExportPart,
  type OpenCodeExportSession,
  opencodeExportSession,
} from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import styles from './GsdSyncActivityView.module.css'

const POLL_INTERVAL_MS = 5000

/**
 * READ-ONLY activity feed for the GSD Sync child session — "subagent" style
 * (no input box, no way to type). Reads `opencode export <sessionID>`
 * directly (no PTY terminal in the path), so there's none of the
 * "readOnly vs. scrollable" architectural conflict a live PTY terminal has —
 * it's a normal HTML `<div>`, scrolls freely.
 */
export function GsdSyncActivityView() {
  const t = useT()
  const view = useUiStore((s) => s.gsdSyncActivityView)
  const close = () => useUiStore.getState().setGsdSyncActivityView(null)

  useOnEscape(
    (e) => {
      e.preventDefault()
      close()
    },
    Boolean(view),
    { capture: true },
  )

  if (!view) return null
  return (
    <div className={styles.backdrop} onClick={close}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={view.title}
        onClick={(e) => e.stopPropagation()}
      >
        <GsdSyncActivityContent view={view} onClose={close} t={t} />
      </div>
    </div>
  )
}

function GsdSyncActivityContent({
  view,
  onClose,
  t,
}: {
  view: { worktreePath: string; sessionId: string; title: string }
  onClose: () => void
  t: ReturnType<typeof useT>
}) {
  const [session, setSession] = useState<OpenCodeExportSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const result = await opencodeExportSession(view.worktreePath, view.sessionId)
        if (!cancelled) {
          setSession(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    }
    void fetchOnce()
    const interval = window.setInterval(() => void fetchOnce(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [view.worktreePath, view.sessionId])

  // Sticks to the bottom when the user is already near it (normal feed/chat
  // behavior) — never forces a scroll if the user scrolled up to read
  // something older.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [session])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Bot size={16} />
          <span>{view.title}</span>
        </div>
        {session ? (
          <div className={styles.headerMeta}>
            {session.info.model?.id ? <span>{session.info.model.id}</span> : null}
            {session.info.tokens ? (
              <span>
                {t('gsdActivity.tokens', {
                  count: session.info.tokens.input + session.info.tokens.output,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          title={t('common.close')}
        >
          <X size={16} />
        </button>
      </header>
      <div className={styles.body} ref={scrollRef} onScroll={onScroll}>
        {error ? <p className={styles.errorText}>{error}</p> : null}
        {!session && !error ? (
          <div className={styles.loading}>
            <Loader2 size={18} className={styles.spin} />
            <span>{t('gsdActivity.loading')}</span>
          </div>
        ) : null}
        {session?.messages.map((message) => (
          <MessageBlock key={message.info.id} message={message} t={t} />
        ))}
      </div>
    </>
  )
}

function MessageBlock({
  message,
  t,
}: {
  message: OpenCodeExportMessage
  t: ReturnType<typeof useT>
}) {
  const isUser = message.info.role === 'user'
  const parts = message.parts.map((part, index) => (
    <PartBlock key={`${message.info.id}-${index}`} part={part} t={t} />
  ))

  // User messages (the instruction sent TO the agent) and assistant messages
  // (what the agent actually said/did) need to be unmistakable at a glance —
  // both used to render as the same plain text block, only differentiated
  // by a small label. Now: the instruction becomes a block collapsed by
  // default (typically a long preamble repeated every round) with a neutral
  // rail; the agent's response always stays expanded, with a colored rail —
  // the "timeline" ends up being agent-only.
  if (isUser) {
    return (
      <details className={styles.instructionBlock}>
        <summary className={styles.instructionSummary}>
          <User size={13} />
          <span>{t('gsdActivity.roleUser')}</span>
          <span className={styles.instructionHint}>{t('gsdActivity.instructionHint')}</span>
        </summary>
        <div className={styles.messageParts}>{parts}</div>
      </details>
    )
  }

  return (
    <section className={styles.agentMessage}>
      <div className={styles.messageRoleAgent}>
        <Bot size={13} />
        <span>{t('gsdActivity.roleAssistant')}</span>
      </div>
      <div className={styles.messageParts}>{parts}</div>
    </section>
  )
}

function PartBlock({ part, t }: { part: OpenCodeExportPart; t: ReturnType<typeof useT> }) {
  if (part.type === 'text' || part.type === 'reasoning') {
    const text = part.text?.trim()
    if (!text) return null
    return <p className={part.type === 'reasoning' ? styles.reasoningText : styles.text}>{text}</p>
  }
  if (part.type === 'tool') {
    return (
      <div className={styles.toolCard}>
        <div className={styles.toolCardHeader}>
          <Wrench size={12} />
          <span className={styles.toolName}>{part.tool}</span>
          <span className={styles.toolStatus}>{part.state.status}</span>
        </div>
        {part.state.input ? (
          <pre className={styles.toolPre}>{formatToolInput(part.state.input)}</pre>
        ) : null}
        {part.state.output ? <p className={styles.toolOutput}>{part.state.output}</p> : null}
      </div>
    )
  }
  if (part.type === 'patch') {
    return <p className={styles.patchLine}>{t('gsdActivity.patchApplied')}</p>
  }
  // step-start/step-finish and any unknown future type: no rendering of
  // their own yet, silently ignored (never breaks the feed over a new
  // schema).
  return null
}

function formatToolInput(input: Record<string, unknown>): string {
  const description = input.description
  if (typeof description === 'string') return description
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

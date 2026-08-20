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
 * Feed de atividade SOMENTE LEITURA da sessão-filha do GSD Sync — estilo
 * "subagente" (nenhuma caixa de entrada, nenhum jeito de digitar). Lê
 * `opencode export <sessionID>` direto (sem terminal PTY nenhum no caminho),
 * então não existe o conflito arquitetural "readOnly vs. scrollável" que um
 * terminal PTY vivo tem — é um `<div>` HTML normal, rola livre.
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

  // Gruda no fim quando o usuário já está perto do fim (comportamento normal
  // de feed/chat) — nunca força scroll se o usuário rolou pra cima pra ler
  // algo mais antigo.
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

  // Mensagens de usuário (instrução enviada PRA o agente) e do assistente
  // (o que o agente de fato disse/fez) precisam ser inconfundíveis à
  // primeira vista — antes as duas renderizavam como o mesmo bloco de texto
  // plano, só com um label pequeno diferenciando. Agora: instrução vira um
  // bloco recolhido por padrão (é tipicamente um preâmbulo longo repetido a
  // cada rodada) com trilho neutro; a resposta do agente fica sempre
  // expandida, com trilho colorido — a "linha do tempo" fica só de agente.
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
  // step-start/step-finish e qualquer type futuro desconhecido: sem
  // renderização própria ainda, ignora silenciosamente (nunca quebra o feed
  // por um schema novo).
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

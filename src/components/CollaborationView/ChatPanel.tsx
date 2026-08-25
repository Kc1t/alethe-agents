import { Loader2, MessageSquare, Paperclip, Send, Terminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { p2pDrainFrames } from '../../lib/api/p2pBridge'
import {
  type Conversation,
  type DecryptedMessage,
  type MessageContentType,
  syncEnsureProjectConversation,
  syncIngestChatTransportFrame,
  syncListDecryptedMessages,
  syncOpenChatRelayMessage,
  syncSealChatRelayMessage,
  syncSendMessageForTransport,
  syncStartDirectConversation,
  syncUploadAttachment,
} from '../../lib/api/syncChat'
import {
  getRendezvousStatus,
  drainRendezvousEvents,
  sendRendezvousFrame,
} from '../../lib/api/syncRendezvous'
import { useT } from '../../lib/i18n'
import { getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { syncLocalIdentity } from '../../lib/tauri'
import { useP2pAutoConnect } from '../../hooks/useP2pAutoConnect'
import { useProjectsStore } from '../../stores/projectsStore'
import { Avatar } from '../ui/Avatar'
import styles from './ChatPanel.module.css'

export type ChatSource =
  | { kind: 'project'; projectId: string; projectName: string }
  | { kind: 'direct'; contactAccountRoute: string; contactDisplayLabel: string }

const POLL_INTERVAL_MS = 4_000

function bytesToBase64(bytes: number[]): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const SLASH_COMMANDS: { keyword: string; type: MessageContentType }[] = [
  { keyword: 'codigo', type: 'code_block' },
  { keyword: 'comando', type: 'command' },
  { keyword: 'teste', type: 'test_result' },
  { keyword: 'bug', type: 'bug_report' },
  { keyword: 'texto', type: 'text' },
]

function initialsFor(deviceId: string) {
  const trimmed = deviceId.replace(/^dev_/, '')
  return trimmed.slice(0, 2).toUpperCase()
}

interface SlashToken {
  start: number
  end: number
  query: string
}

function findSlashToken(value: string, cursor: number): SlashToken | null {
  let start = cursor
  while (start > 0 && value[start - 1] !== ' ') start--
  let end = cursor
  while (end < value.length && value[end] !== ' ') end++
  if (value[start] !== '/') return null
  return { start, end, query: value.slice(start + 1, end) }
}

export function ChatPanel({ source }: { source: ChatSource }) {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const ownDisplayName = preferences.displayName || t('profile.fallbackName')
  const ownAvatarUrl = getProfileImageUrl(preferences)
  const ownInitial = getProfileInitial(ownDisplayName)
  const otherDisplayLabel = source.kind === 'direct' ? source.contactDisplayLabel : null
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<DecryptedMessage[]>([])
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null)
  const [localAccountRoute, setLocalAccountRoute] = useState<string | null>(null)
  const [rendezvousConnected, setRendezvousConnected] = useState(false)
  const [error, setError] = useState(false)

  const otherMember = useMemo(
    () => conversation?.members.find((member) => member.accountRoute !== localAccountRoute) ?? null,
    [conversation, localAccountRoute],
  )
  const p2p = useP2pAutoConnect(otherMember?.accountRoute ?? null)
  const [draft, setDraft] = useState('')
  const [contentType, setContentType] = useState<MessageContentType>('text')
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [slashHighlight, setSlashHighlight] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const textInputRef = useRef<HTMLInputElement | null>(null)

  const [slashToken, setSlashToken] = useState<SlashToken | null>(null)
  const slashMatches = useMemo(() => {
    if (!slashToken) return []
    return SLASH_COMMANDS.filter((option) =>
      option.keyword.startsWith(slashToken.query.toLowerCase()),
    )
  }, [slashToken])
  const slashMenuOpen = slashToken !== null

  useEffect(() => {
    setSlashHighlight(0)
  }, [slashToken?.start, slashToken?.end, slashToken?.query])

  const updateSlashToken = (value: string, cursor: number) => {
    setSlashToken(findSlashToken(value, cursor))
  }

  const applySlashCommand = (type: MessageContentType) => {
    if (!slashToken) return
    setContentType(type)
    const before = draft.slice(0, slashToken.start)
    const after = draft.slice(slashToken.end)
    const nextDraft = `${before}${after}`
    setDraft(nextDraft)
    setSlashToken(null)
    requestAnimationFrame(() => {
      const input = textInputRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(before.length, before.length)
    })
  }

  useEffect(() => {
    let active = true
    syncLocalIdentity()
      .then((identity) => {
        if (!active) return
        setLocalDeviceId(identity.deviceId)
        setLocalAccountRoute(identity.accountRoute)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  // Kicks off signaling for the conversation's other member (if any) the moment we know both who
  // they are and their X25519 key — see `useP2pAutoConnect` for what this actually does.
  useEffect(() => {
    if (!otherMember) return
    p2p.connect(bytesToBase64(otherMember.x25519PublicKey))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherMember?.accountRoute])

  useEffect(() => {
    let active = true
    let timer: number | undefined
    setConversation(null)
    setMessages([])
    setError(false)

    const poll = async (conversationId: string) => {
      try {
        const list = await syncListDecryptedMessages(conversationId)
        if (active) {
          setMessages(list)
          setError(false)
        }
      } catch {
        if (active) setError(true)
      }
    }

    const resolve =
      source.kind === 'project'
        ? syncEnsureProjectConversation(source.projectId)
        : syncStartDirectConversation(source.contactAccountRoute)

    resolve
      .then(async (conv) => {
        if (!active) return
        setConversation(conv)
        await poll(conv.conversationId)
        timer = window.setInterval(() => void poll(conv.conversationId), POLL_INTERVAL_MS)
      })
      .catch(() => {
        if (active) setError(true)
      })

    return () => {
      active = false
      if (timer) window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind === 'project' ? source.projectId : source.contactAccountRoute])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  // Drains any message frames that arrived since the last tick (direct P2P session, or the
  // Cloudflare relay as a `chat_message` envelope) and persists them via
  // `syncIngestChatTransportFrame` — which writes to the exact same local conversation file the
  // poll effect above already re-reads every `POLL_INTERVAL_MS`, so a delivered message simply
  // shows up on the next tick without any separate merge logic here.
  useEffect(() => {
    if (!conversation || !otherMember) return
    let active = true
    const conversationId = conversation.conversationId
    const accountRoute = otherMember.accountRoute

    const drain = async () => {
      try {
        const status = await getRendezvousStatus()
        if (active) setRendezvousConnected(status.state !== 'no_attempt_yet')
      } catch {
        // Rendezvous status is best-effort for the badge only.
      }
      if (p2p.state === 'p2p') {
        try {
          const frames = await p2pDrainFrames(accountRoute)
          for (const frame of frames) {
            await syncIngestChatTransportFrame(conversationId, frame).catch(() => undefined)
          }
        } catch {
          // A closed/failed session here just means nothing to drain this tick.
        }
      }
      try {
        const events = await drainRendezvousEvents()
        for (const event of events) {
          if (event.eventType !== 'delivery' || event.envelopeKind !== 'chat_message') continue
          if (!event.ciphertext) continue
          try {
            const plaintext = await syncOpenChatRelayMessage(event.ciphertext)
            await syncIngestChatTransportFrame(conversationId, plaintext)
          } catch {
            // Not addressed to this device/conversation — ignore.
          }
        }
      } catch {
        // Relay drain is best-effort — the local poll still shows whatever was already ingested.
      }
    }

    void drain()
    const timer = window.setInterval(() => void drain(), POLL_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [conversation, otherMember, p2p.state])

  const send = async () => {
    if (!conversation || !draft.trim()) return
    setSending(true)
    try {
      const [message, frame] = await syncSendMessageForTransport(
        conversation.conversationId,
        contentType,
        draft.trim(),
      )
      setMessages((current) => [...current, message])
      setDraft('')
      setContentType('text')
      setSlashToken(null)

      if (otherMember && frame.length > 0) {
        if (p2p.state === 'p2p') {
          await p2p.send(frame).catch(async () => {
            // Direct delivery failed after all (session dropped mid-send) — fall back to relay.
            await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
          })
        } else {
          await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
        }
      }
    } catch {
      setError(true)
    } finally {
      setSending(false)
    }
  }

  const deliverViaRelay = async (
    frame: number[],
    recipientAccountRoute: string,
    recipientAgreementPublicKey: number[],
  ) => {
    try {
      const ciphertext = await syncSealChatRelayMessage(
        frame,
        bytesToBase64(recipientAgreementPublicKey),
      )
      await sendRendezvousFrame({
        type: 'enqueue',
        kind: 'chat_message',
        messageId: `chat_${crypto.randomUUID()}`,
        recipientAccountRoute,
        expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        ciphertext,
      })
    } catch {
      // Best-effort — the message is already saved locally either way; only live delivery failed.
    }
  }

  const attachFile = async (file: File) => {
    if (!conversation) return
    setAttaching(true)
    try {
      const buffer = await file.arrayBuffer()
      const bytes = Array.from(new Uint8Array(buffer))
      const attachment = await syncUploadAttachment(
        conversation.conversationId,
        file.type || 'application/octet-stream',
        bytes,
      )
      // The attachment binary itself only ever goes through `syncUploadAttachment` above (never
      // the relay — see `MAX_CIPHERTEXT_BYTES`/16KB in `sync_rendezvous.rs`); only this short
      // pointer text is eligible for live P2P/relay delivery, same as any other text message.
      const [message, frame] = await syncSendMessageForTransport(
        conversation.conversationId,
        'text',
        t('chat.attachmentMessage', { name: file.name, id: attachment.attachmentId }),
      )
      setMessages((current) => [...current, message])
      if (otherMember && frame.length > 0) {
        if (p2p.state === 'p2p') {
          await p2p.send(frame).catch(async () => {
            await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
          })
        } else {
          await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
        }
      }
    } catch {
      setError(true)
    } finally {
      setAttaching(false)
    }
  }

  const connectionState: 'local' | 'connecting' | 'p2p' | 'relay' = !otherMember
    ? 'local'
    : p2p.state === 'p2p'
      ? 'p2p'
      : p2p.state === 'signaling'
        ? 'connecting'
        : rendezvousConnected
          ? 'relay'
          : 'local'

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          {source.kind === 'direct' ? source.contactDisplayLabel : source.projectName}
        </span>
        <span className={`${styles.e2eBadge} ${styles[`e2eBadge_${connectionState}`]}`}>
          {t(`chat.connectionState.${connectionState}`)}
        </span>
      </div>

      <div className={styles.messages}>
        {!conversation && !error ? (
          <div className={styles.loading}>
            <Loader2 size={18} className={styles.spin} />
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            <MessageSquare size={28} className={styles.emptyIcon} />
            <span>{t('chat.empty')}</span>
          </div>
        ) : (
          messages.map((message) => {
            const own = message.senderDeviceId === localDeviceId
            return (
              <div
                key={message.messageId}
                className={`${styles.messageRow} ${own ? styles.messageRowOwn : ''}`}
              >
                <div className={styles.avatar}>
                  {own ? (
                    <Avatar src={ownAvatarUrl} initial={ownInitial} className={styles.avatarImg} />
                  ) : (
                    <Avatar
                      src={null}
                      initial={
                        otherDisplayLabel
                          ? getProfileInitial(otherDisplayLabel)
                          : initialsFor(message.senderDeviceId)
                      }
                      className={styles.avatarImg}
                    />
                  )}
                </div>
                <div className={styles.messageBubbleWrap}>
                  <div className={styles.messageMeta}>
                    <span className={styles.messageAuthor}>
                      {own ? ownDisplayName : (otherDisplayLabel ?? message.senderDeviceId)}
                    </span>
                    <span className={styles.messageTime}>
                      {new Date(message.createdAtMs).toLocaleTimeString()}
                    </span>
                  </div>
                  {message.contentType === 'command' ? (
                    <div className={`${styles.commandBlock} ${own ? styles.bubbleOwn : ''}`}>
                      <div className={styles.commandLabel}>
                        <Terminal size={11} />
                        {t('chat.contentType.command')}
                      </div>
                      <code>{message.text}</code>
                    </div>
                  ) : message.contentType === 'code_block' ? (
                    <pre className={`${styles.codeBlock} ${own ? styles.bubbleOwn : ''}`}>
                      <code>{message.text}</code>
                    </pre>
                  ) : message.contentType === 'test_result' ||
                    message.contentType === 'bug_report' ? (
                    <div className={`${styles.structuredBlock} ${own ? styles.bubbleOwn : ''}`}>
                      <span className={styles.structuredLabel}>
                        {t(`chat.contentType.${message.contentType}`)}
                      </span>
                      <p>{message.text}</p>
                    </div>
                  ) : (
                    <p
                      className={`${styles.messageText} ${own ? styles.bubbleOwn : styles.bubbleOther}`}
                    >
                      {message.text}
                    </p>
                  )}
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {error ? <div className={styles.error}>{t('chat.loadFailed')}</div> : null}

      <div className={styles.syncNotice}>{t(`chat.syncNotice.${connectionState}`)}</div>

      <div className={styles.composer}>
        {slashMenuOpen ? (
          <div className={styles.slashMenu}>
            <div className={styles.slashMenuHint}>{t('chat.slashHint')}</div>
            {slashMatches.length === 0 ? (
              <div className={styles.slashMenuEmpty}>{t('chat.slashNoMatch')}</div>
            ) : (
              slashMatches.map((option, index) => (
                <button
                  key={option.keyword}
                  type="button"
                  className={`${styles.slashOption} ${index === slashHighlight ? styles.slashOptionActive : ''}`}
                  onMouseEnter={() => setSlashHighlight(index)}
                  onClick={() => applySlashCommand(option.type)}
                >
                  <span className={styles.slashOptionKeyword}>/{option.keyword}</span>
                  <span className={styles.slashOptionLabel}>
                    {t(`chat.contentType.${option.type}`)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {contentType !== 'text' ? (
          <span className={styles.activeTypePill}>
            {t(`chat.contentType.${contentType}`)}
            <button
              type="button"
              className={styles.activeTypePillClear}
              onClick={() => setContentType('text')}
              title={t('chat.slashClear')}
            >
              <X size={11} />
            </button>
          </span>
        ) : null}
        <div className={styles.inputPill}>
          <input
            ref={textInputRef}
            className={styles.textInput}
            value={draft}
            placeholder={t('chat.composerPlaceholder')}
            onChange={(event) => {
              const { value, selectionStart } = event.target
              setDraft(value)
              updateSlashToken(value, selectionStart ?? value.length)
            }}
            onClick={(event) => {
              const { value, selectionStart } = event.currentTarget
              updateSlashToken(value, selectionStart ?? value.length)
            }}
            onKeyUp={(event) => {
              if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                const { value, selectionStart } = event.currentTarget
                updateSlashToken(value, selectionStart ?? value.length)
              }
            }}
            onKeyDown={(event) => {
              if (slashMenuOpen) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSlashHighlight((current) => (current + 1) % Math.max(slashMatches.length, 1))
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSlashHighlight(
                    (current) =>
                      (current - 1 + Math.max(slashMatches.length, 1)) %
                      Math.max(slashMatches.length, 1),
                  )
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setSlashToken(null)
                  return
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  const match = slashMatches[slashHighlight]
                  if (match) applySlashCommand(match.type)
                  return
                }
                return
              }
              if (event.key === 'Enter') void send()
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            className={styles.hiddenFileInput}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void attachFile(file)
              event.target.value = ''
            }}
          />
          <button
            type="button"
            className={styles.iconButton}
            disabled={attaching || !conversation}
            onClick={() => fileInputRef.current?.click()}
            title={t('chat.attachFile')}
          >
            {attaching ? <Loader2 size={14} className={styles.spin} /> : <Paperclip size={14} />}
          </button>
        </div>
        <button
          type="button"
          className={styles.sendButton}
          disabled={sending || !draft.trim() || !conversation}
          onClick={() => void send()}
        >
          {sending ? <Loader2 size={14} className={styles.spin} /> : <Send size={14} />}
        </button>
      </div>
    </div>
  )
}

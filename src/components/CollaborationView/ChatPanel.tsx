import { Loader2, MessageSquare, Paperclip, Send, Terminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useP2pAutoConnect } from '../../hooks/useP2pAutoConnect'
import { p2pDrainFrames } from '../../lib/api/p2pBridge'
import { subscribeToRendezvousEvents } from '../../lib/api/rendezvousEventBus'
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
import { connectRendezvous, getRendezvousStatus, sendRendezvousFrame } from '../../lib/api/syncRendezvous'
import { useT } from '../../lib/i18n'
import { getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { syncLocalIdentity } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { Avatar } from '../ui/Avatar'
import styles from './ChatPanel.module.css'

export type ChatSource =
  | { kind: 'project'; projectId: string; projectName: string }
  | { kind: 'direct'; contactAccountRoute: string; contactDisplayLabel: string }

const POLL_INTERVAL_MS = 4_000

// Cross-device delivery (relay/P2P) can land messages out of order — a locally-sent message
// appends immediately, while a peer's message might arrive moments later but with an earlier
// `sequence`/timestamp. Always re-sorting keeps the thread in true chronological order, WhatsApp-
// style, instead of "arrival order" which can visibly shuffle once both sides are actually live.
//
// Sorts by `createdAtMs` first, NOT `sequence`: `sequence` is a per-device, per-conversation-file
// counter (`next_sequence` in `sync_chat.rs`) — each side's own copy of the conversation starts
// counting from 1 independently, so "my message #1" and "their message #1" are unrelated numbers
// that happen to collide, not two points on one shared timeline. Comparing them first (as this
// used to) could sort a later message before an earlier one whenever the two devices' own local
// counts didn't happen to agree with wall-clock order — reproduced live. `sequence` is still a
// useful *tiebreaker* for two messages with the exact same timestamp from the same device.
function sortMessages(list: DecryptedMessage[]): DecryptedMessage[] {
  return [...list].sort((a, b) => a.createdAtMs - b.createdAtMs || a.sequence - b.sequence)
}

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

interface MentionToken {
  start: number
  end: number
  query: string
}

function findMentionToken(value: string, cursor: number): MentionToken | null {
  let start = cursor
  while (start > 0 && value[start - 1] !== ' ') start--
  let end = cursor
  while (end < value.length && value[end] !== ' ') end++
  if (value[start] !== '@') return null
  return { start, end, query: value.slice(start + 1, end) }
}

// Splits rendered message text on `@name` runs so they can be styled distinctly — deliberately not
// tied to conversation membership (a mention's target is already resolved server-side into
// `message.mentions`/`AccessKind::ChatMention`; this is purely a rendering affordance, so any
// `@word` the sender typed is highlighted the same way, including for messages from before this
// device knew every member's display name).
const MENTION_SPLIT_PATTERN = /(@[^\s@]+)/g
const MENTION_MATCH_PATTERN = /^@[^\s@]+$/
function renderWithMentions(text: string) {
  const parts = text.split(MENTION_SPLIT_PATTERN)
  return parts.map((part, index) =>
    MENTION_MATCH_PATTERN.test(part) ? (
      <span key={index} className={styles.mentionHighlight}>
        {part}
      </span>
    ) : (
      part
    ),
  )
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

  // `@`-mention autocomplete — mirrors the slash-command token pattern above exactly, just
  // triggered by `@` and inserting a name instead of picking a content type. Candidates come from
  // the conversation's other members: for a Direct chat that's only ever the one contact (with a
  // real display name already known from pairing/renaming); for a project channel it's every other
  // member, falling back to their account route since no per-member display-name mapping exists
  // client-side yet.
  const [mentionToken, setMentionToken] = useState<MentionToken | null>(null)
  const [mentionHighlight, setMentionHighlight] = useState(0)
  const [pendingMentionRoutes, setPendingMentionRoutes] = useState<Set<string>>(new Set())
  const mentionCandidates = useMemo(() => {
    if (!conversation) return []
    return conversation.members
      .filter((member) => member.accountRoute !== localAccountRoute)
      .map((member) => ({
        accountRoute: member.accountRoute,
        label:
          member.accountRoute === otherMember?.accountRoute
            ? (otherDisplayLabel ?? member.accountRoute)
            : member.accountRoute,
      }))
  }, [conversation, localAccountRoute, otherMember, otherDisplayLabel])
  const mentionMatches = useMemo(() => {
    if (!mentionToken) return []
    const query = mentionToken.query.toLowerCase()
    return mentionCandidates.filter((candidate) => candidate.label.toLowerCase().includes(query))
  }, [mentionToken, mentionCandidates])
  const mentionMenuOpen = mentionToken !== null

  useEffect(() => {
    setMentionHighlight(0)
  }, [mentionToken?.start, mentionToken?.end, mentionToken?.query])

  const updateMentionToken = (value: string, cursor: number) => {
    setMentionToken(findMentionToken(value, cursor))
  }

  const applyMention = (candidate: { accountRoute: string; label: string }) => {
    if (!mentionToken) return
    const before = draft.slice(0, mentionToken.start)
    const after = draft.slice(mentionToken.end)
    const inserted = `@${candidate.label} `
    const nextDraft = `${before}${inserted}${after}`
    setDraft(nextDraft)
    setPendingMentionRoutes((current) => new Set(current).add(candidate.accountRoute))
    setMentionToken(null)
    requestAnimationFrame(() => {
      const input = textInputRef.current
      if (!input) return
      input.focus()
      const cursor = before.length + inserted.length
      input.setSelectionRange(cursor, cursor)
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
          setMessages(sortMessages(list))
          setError(false)
        }
      } catch (cause) {
        console.error('[chat] syncListDecryptedMessages failed', cause)
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
      .catch((cause) => {
        console.error('[chat] failed to resolve conversation', cause)
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

  // Connection status + P2P frame draining. `chat_message` relay events are handled separately
  // below, via the shared event bus — this used to call `drainRendezvousEvents()` directly here
  // too, which raced with `ChatTab.tsx`'s own independent poller for the exact same shared,
  // drain-once queue: whichever of the two happened to call first that tick "stole" every event,
  // including kinds it didn't care about, silently discarding them — a real, confirmed bug behind
  // messages that were sent successfully but simply never showed up on the receiving side.
  useEffect(() => {
    if (!conversation || !otherMember) return
    let active = true
    const conversationId = conversation.conversationId
    const accountRoute = otherMember.accountRoute

    const drain = async () => {
      try {
        const status = await getRendezvousStatus()
        if (active) setRendezvousConnected(status.state !== 'no_attempt_yet')
        if (status.state !== 'online') {
          console.info('[chat] rendezvous status', status)
        }
        // The backend's own retry loop only runs while a connection attempt is in flight — once
        // it gives up (or was never started because this device just launched) it settles on
        // `no_attempt_yet` forever, with nothing to kick it again. A conversation being open here
        // means we *do* want to be connected, so treat this as "reconnect", not just a status to
        // display — otherwise a dropped connection silently stays dead until something else (like
        // reopening the conversation) happens to call `connectRendezvous()` again.
        if (status.state === 'no_attempt_yet') {
          console.info('[chat] rendezvous is not connected — reconnecting…')
          await connectRendezvous().catch((cause) => {
            console.error('[chat] auto-reconnect failed', cause)
          })
        }
      } catch (cause) {
        console.error('[chat] getRendezvousStatus failed', cause)
      }
      if (p2p.state === 'p2p') {
        try {
          const frames = await p2pDrainFrames(accountRoute)
          if (frames.length > 0) console.info('[chat] p2p frames received', frames.length)
          for (const frame of frames) {
            await syncIngestChatTransportFrame(conversationId, frame).catch((cause) => {
              console.error('[chat] failed to ingest p2p frame', cause)
            })
          }
        } catch (cause) {
          console.error('[chat] p2pDrainFrames failed', cause)
        }
      }
    }

    void drain()
    const timer = window.setInterval(() => void drain(), POLL_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [conversation, otherMember, p2p.state])

  // `chat_message` relay deliveries, via the shared event bus (see `rendezvousEventBus.ts`) so
  // this never competes with any other listener for the same drain-once queue.
  useEffect(() => {
    if (!conversation || !otherMember) return
    const conversationId = conversation.conversationId
    return subscribeToRendezvousEvents((events) => {
      const chatEvents = events.filter((event) => event.envelopeKind === 'chat_message')
      if (chatEvents.length === 0) return
      console.info('[chat] chat_message envelopes received via relay', chatEvents.length)
      void (async () => {
        for (const event of chatEvents) {
          if (event.eventType !== 'delivery' || !event.ciphertext) continue
          try {
            const plaintext = await syncOpenChatRelayMessage(event.ciphertext)
            await syncIngestChatTransportFrame(conversationId, plaintext)
            console.info('[chat] relay message decrypted and ingested')
          } catch (cause) {
            // Not addressed to this device/conversation — but could also be a real decrypt bug,
            // so log it instead of hiding it entirely.
            console.warn('[chat] relay message could not be opened/ingested (may be for someone else)', cause)
          }
        }
      })()
    })
  }, [conversation, otherMember])

  const send = async () => {
    if (!conversation || !draft.trim()) return
    setSending(true)
    const startedAt = performance.now()
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`
    try {
      const [message, frame] = await syncSendMessageForTransport(
        conversation.conversationId,
        contentType,
        draft.trim(),
        Array.from(pendingMentionRoutes),
      )
      console.info(`[chat] local encrypt+save done (${elapsed()})`)
      setMessages((current) => sortMessages([...current, message]))
      setDraft('')
      setContentType('text')
      setSlashToken(null)
      setMentionToken(null)
      setPendingMentionRoutes(new Set())

      if (otherMember && frame.length > 0) {
        if (p2p.state === 'p2p') {
          await p2p.send(frame).catch(async (cause) => {
            // Direct delivery failed after all (session dropped mid-send) — fall back to relay.
            console.warn(`[chat] p2p.send failed mid-send (${elapsed()}), falling back to relay`, cause)
            await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
          })
        } else {
          await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
        }
      }
      console.info(`[chat] send() finished (${elapsed()})`)
    } catch (cause) {
      console.error(`[chat] failed to send message (${elapsed()})`, cause)
      setError(true)
    } finally {
      setSending(false)
    }
  }

  // How many times to retry an enqueue before giving up — covers the common "sent immediately
  // after pairing/adding a contact" case, where the rendezvous connection (or the freshly-adopted
  // endpoint) hasn't finished coming up yet by the time the very first message is sent. Reproduced
  // live: a message sent right after pairing silently never arrived, because the single enqueue
  // attempt failed while the connection was still settling and nothing ever retried it — the
  // message stayed saved locally (visible only to the sender) forever.
  const RELAY_DELIVERY_RETRY_DELAYS_MS = [800, 2_000, 5_000]

  const deliverViaRelay = async (
    frame: number[],
    recipientAccountRoute: string,
    recipientAgreementPublicKey: number[],
  ) => {
    const startedAt = performance.now()
    const messageId = `chat_${crypto.randomUUID()}`
    try {
      const ciphertext = await syncSealChatRelayMessage(
        frame,
        bytesToBase64(recipientAgreementPublicKey),
      )
      for (let attempt = 0; ; attempt++) {
        try {
          // Idempotent no-op if a connection attempt is already in flight/online (see
          // `sync_rendezvous.rs`'s `start_at` guard) — makes sure a message sent the instant after
          // pairing doesn't race a relay connection that hasn't come up yet.
          await connectRendezvous()
          await sendRendezvousFrame({
            type: 'enqueue',
            kind: 'chat_message',
            id: messageId,
            recipientAccountRoute,
            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
            ciphertext,
          })
          console.info(
            `[chat] message sent via relay (${Math.round(performance.now() - startedAt)}ms, attempt ${attempt + 1})`,
            { recipientAccountRoute },
          )
          return
        } catch (cause) {
          if (attempt >= RELAY_DELIVERY_RETRY_DELAYS_MS.length) throw cause
          console.warn(
            `[chat] deliverViaRelay attempt ${attempt + 1} failed, retrying in ${RELAY_DELIVERY_RETRY_DELAYS_MS[attempt]}ms`,
            cause,
          )
          await new Promise((resolve) => setTimeout(resolve, RELAY_DELIVERY_RETRY_DELAYS_MS[attempt]))
        }
      }
    } catch (cause) {
      // Only after every retry above was exhausted — the message is already saved locally either
      // way; only live delivery failed.
      console.error(
        `[chat] deliverViaRelay failed permanently (${Math.round(performance.now() - startedAt)}ms)`,
        cause,
      )
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
      setMessages((current) => sortMessages([...current, message]))
      if (otherMember && frame.length > 0) {
        if (p2p.state === 'p2p') {
          await p2p.send(frame).catch(async () => {
            await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
          })
        } else {
          await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
        }
      }
    } catch (cause) {
      console.error('[chat] failed to attach file', cause)
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
                      {renderWithMentions(message.text)}
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
        {mentionMenuOpen && !slashMenuOpen ? (
          <div className={styles.slashMenu}>
            <div className={styles.slashMenuHint}>{t('chat.mentionHint')}</div>
            {mentionMatches.length === 0 ? (
              <div className={styles.slashMenuEmpty}>{t('chat.mentionNoMatch')}</div>
            ) : (
              mentionMatches.map((candidate, index) => (
                <button
                  key={candidate.accountRoute}
                  type="button"
                  className={`${styles.slashOption} ${index === mentionHighlight ? styles.slashOptionActive : ''}`}
                  onMouseEnter={() => setMentionHighlight(index)}
                  onClick={() => applyMention(candidate)}
                >
                  <span className={styles.slashOptionKeyword}>@{candidate.label}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
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
              updateMentionToken(value, selectionStart ?? value.length)
            }}
            onClick={(event) => {
              const { value, selectionStart } = event.currentTarget
              updateSlashToken(value, selectionStart ?? value.length)
              updateMentionToken(value, selectionStart ?? value.length)
            }}
            onKeyUp={(event) => {
              if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                const { value, selectionStart } = event.currentTarget
                updateSlashToken(value, selectionStart ?? value.length)
                updateMentionToken(value, selectionStart ?? value.length)
              }
            }}
            onKeyDown={(event) => {
              if (mentionMenuOpen && !slashMenuOpen) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setMentionHighlight((current) => (current + 1) % Math.max(mentionMatches.length, 1))
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setMentionHighlight(
                    (current) =>
                      (current - 1 + Math.max(mentionMatches.length, 1)) %
                      Math.max(mentionMatches.length, 1),
                  )
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setMentionToken(null)
                  return
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  const match = mentionMatches[mentionHighlight]
                  if (match) applyMention(match)
                  return
                }
              }
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

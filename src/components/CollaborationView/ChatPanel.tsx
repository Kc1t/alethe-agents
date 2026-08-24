import { Loader2, MessageSquare, Paperclip, Send, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  syncEnsureProjectConversation,
  syncListDecryptedMessages,
  syncSendMessage,
  syncUploadAttachment,
  type Conversation,
  type DecryptedMessage,
  type MessageContentType,
} from '../../lib/api/syncChat'
import { syncLocalIdentity } from '../../lib/tauri'
import styles from './ChatPanel.module.css'

const POLL_INTERVAL_MS = 4_000
const CONTENT_TYPES: MessageContentType[] = [
  'text',
  'code_block',
  'command',
  'test_result',
  'bug_report',
]

function initialsFor(deviceId: string) {
  const trimmed = deviceId.replace(/^dev_/, '')
  return trimmed.slice(0, 2).toUpperCase()
}

export function ChatPanel({ projectId }: { projectId: string }) {
  const t = useT()
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<DecryptedMessage[]>([])
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [draft, setDraft] = useState('')
  const [contentType, setContentType] = useState<MessageContentType>('text')
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let active = true
    syncLocalIdentity()
      .then((identity) => {
        if (active) setLocalDeviceId(identity.deviceId)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

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

    syncEnsureProjectConversation(projectId)
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
  }, [projectId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const send = async () => {
    if (!conversation || !draft.trim()) return
    setSending(true)
    try {
      const message = await syncSendMessage(conversation.conversationId, contentType, draft.trim())
      setMessages((current) => [...current, message])
      setDraft('')
      setContentType('text')
    } catch {
      setError(true)
    } finally {
      setSending(false)
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
      const message = await syncSendMessage(
        conversation.conversationId,
        'text',
        t('chat.attachmentMessage', { name: file.name, id: attachment.attachmentId }),
      )
      setMessages((current) => [...current, message])
    } catch {
      setError(true)
    } finally {
      setAttaching(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t('chat.channelTitle')}</span>
        <span className={styles.e2eBadge}>{t('chat.e2eBadge')}</span>
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
          messages.map((message, index) => {
            const own = message.senderDeviceId === localDeviceId
            const previous = messages[index - 1]
            const grouped = previous?.senderDeviceId === message.senderDeviceId
            return (
              <div
                key={message.messageId}
                className={`${styles.messageRow} ${own ? styles.messageRowOwn : ''}`}
              >
                {!own ? (
                  <div className={`${styles.avatar} ${grouped ? styles.avatarSpacer : ''}`}>
                    {grouped ? null : initialsFor(message.senderDeviceId)}
                  </div>
                ) : null}
                <div className={styles.messageBubbleWrap}>
                  {!grouped ? (
                    <div className={styles.messageMeta}>
                      {!own ? (
                        <span className={styles.messageAuthor}>{message.senderDeviceId}</span>
                      ) : null}
                      <span className={styles.messageTime}>
                        {new Date(message.createdAtMs).toLocaleTimeString()}
                      </span>
                    </div>
                  ) : null}
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

      <div className={styles.syncNotice}>{t('chat.localOnlyNotice')}</div>

      <div className={styles.composer}>
        <select
          className={styles.typeSelect}
          value={contentType}
          onChange={(event) => setContentType(event.target.value as MessageContentType)}
        >
          {CONTENT_TYPES.map((option) => (
            <option key={option} value={option}>
              {t(`chat.contentType.${option}`)}
            </option>
          ))}
        </select>
        <div className={styles.inputPill}>
          <input
            className={styles.textInput}
            value={draft}
            placeholder={t('chat.composerPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
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

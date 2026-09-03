import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  Eraser,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Search,
  Send,
  Terminal,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useP2pAutoConnect } from '../../hooks/useP2pAutoConnect'
import { sendAvatarUpdateTo } from '../../lib/api/avatarSync'
import { sendBioUpdateTo } from '../../lib/api/bioSync'
import { p2pDrainFrames } from '../../lib/api/p2pBridge'
import { P2P_CHANNEL_CHAT, P2P_CHANNEL_FILE_SYNC, untagFrame } from '../../lib/api/p2pChannel'
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
import {
  syncFilePipelineIngestFrame,
  syncFilePipelineOfferProject,
} from '../../lib/api/syncFilePipeline'
import {
  connectRendezvous,
  getRendezvousStatus,
  sendRendezvousFrame,
} from '../../lib/api/syncRendezvous'
import { isTauriEnv } from '../../lib/api/transport'
import {
  encodeAttachmentReferences,
  guessMimeFromName,
  parseAttachmentReferences,
  previewKindFor,
} from '../../lib/attachmentReference'
import { withCorrelation } from '../../lib/correlation'
import { useT } from '../../lib/i18n'
import { DEFAULT_PROFILE_IMAGE_URL, getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { readBinaryFile, syncLocalIdentity } from '../../lib/tauri'
import { getProjectRepoRoot } from '../../lib/terminalFactory'
import { useProjectsStore } from '../../stores/projectsStore'
import { Avatar } from '../ui/Avatar'
import { AttachmentGrid } from './AttachmentGrid'
import { AttachmentPreview } from './AttachmentPreview'
import styles from './ChatPanel.module.css'
import { InviteToProject } from './InviteToProject'
import { Lightbox } from './Lightbox'

export type ChatSource =
  | { kind: 'project'; projectId: string; projectName: string }
  | {
      kind: 'direct'
      contactAccountRoute: string
      contactDisplayLabel: string
      contactAvatarThumbnail?: string | null
      /** Read-only here — nothing on this device ever writes another contact's bio, only its own
       * (edited in Preferences, see `bioSync.ts`). */
      contactBio?: string | null
    }

/** Only meaningful for a `'direct'` source — the actions that used to live as three small icon
 * buttons inline in the contact list row now live in the contact-info panel opened from the chat
 * header instead (rename moved into the panel's own header; "remove" and "delete everything" were
 * two separate destructive actions that both ended a contact relationship — consolidated into the
 * one `onDeleteAll` action instead of keeping both). Owned by `ChatTab.tsx` (it already holds the
 * contact list and the prompts/confirmations for these), just rendered from here. */
export type ChatContactActions = {
  onRename: (newDisplayLabel: string) => void
  onDeleteAll: () => void
}

const POLL_INTERVAL_MS = 4_000
/// Ceiling on files pinned above the composer at once — a paste/selection with more than this
/// (e.g. an entire folder) is silently truncated rather than staging all of them, both to keep
/// the pinned-chip row usable and to avoid `send()` firing that many sequential uploads at once.
const MAX_PENDING_ATTACHMENTS = 10

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

/** Cheap "did anything actually change?" check for the 4s poll. The poll re-reads the whole
 * conversation every tick, so without this it replaced the message array with a fresh (but
 * identical) one every 4 seconds, re-rendering every bubble and every attachment component in a
 * long conversation forever. Comparing ids/edit stamps is far cheaper than that re-render. */
function sameMessages(a: DecryptedMessage[], b: DecryptedMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].messageId !== b[index].messageId) return false
    if (a[index].editedAtMs !== b[index].editedAtMs) return false
    if (a[index].text !== b[index].text) return false
  }
  return true
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Renders message text with `@mentions` styled distinctly, and — while a message search is
 * active — the matching search substring highlighted too (case-insensitive), so a result reads as
 * obviously matched instead of the search feeling like it filtered the list for no visible reason. */
function renderMessageText(text: string, searchQuery: string) {
  const mentionParts = text.split(MENTION_SPLIT_PATTERN)
  const trimmedQuery = searchQuery.trim()
  const searchPattern = trimmedQuery ? new RegExp(`(${escapeRegExp(trimmedQuery)})`, 'ig') : null

  return mentionParts.map((part, partIndex) => {
    if (MENTION_MATCH_PATTERN.test(part)) {
      return (
        <span key={partIndex} className={styles.mentionHighlight}>
          {part}
        </span>
      )
    }
    if (!searchPattern) return part
    const searchSegments = part.split(searchPattern)
    return (
      <span key={partIndex}>
        {searchSegments.map((segment, segmentIndex) =>
          segment.toLowerCase() === trimmedQuery.toLowerCase() && segment !== '' ? (
            <mark key={segmentIndex} className={styles.searchHighlight}>
              {segment}
            </mark>
          ) : (
            segment
          ),
        )}
      </span>
    )
  })
}

export function ChatPanel({
  source,
  contactActions,
}: {
  source: ChatSource
  contactActions?: ChatContactActions
}) {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const ownDisplayName = preferences.displayName || t('profile.fallbackName')
  const ownAvatarUrl = getProfileImageUrl(preferences)
  const ownInitial = getProfileInitial(ownDisplayName)
  const otherDisplayLabel = source.kind === 'direct' ? source.contactDisplayLabel : null
  // Same fallback as `ownAvatarUrl` (the app's bundled default icon, not the bare initial) when
  // the contact has no real photo synced yet — keeps "no photo set" looking identical on both
  // sides instead of one showing a generic icon and the other a plain initial.
  const otherAvatarUrl =
    source.kind === 'direct' ? source.contactAvatarThumbnail || DEFAULT_PROFILE_IMAGE_URL : null
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
  // Everyone else in the conversation — for a project channel this is every collaborator with
  // access, shown as a row of avatars in the header (WhatsApp-style), so people already know who
  // else is in the channel without opening the collaborators list separately.
  const otherMembers = useMemo(
    () => conversation?.members.filter((member) => member.accountRoute !== localAccountRoute) ?? [],
    [conversation, localAccountRoute],
  )
  const p2p = useP2pAutoConnect(otherMember?.accountRoute ?? null)
  // Manual "sync project now" trigger — see `syncFilePipeline.ts`. Deliberately manual (not
  // automatic on connect) for this first testable pass: no background watcher is wired to trigger
  // it yet, and starting a transfer of arbitrary size the instant two peers connect would be a
  // surprise, not a convenience, before this path has been proven reliable.
  const localProject = useProjectsStore((state) =>
    source.kind === 'project'
      ? (state.projects.find((project) => project.id === source.projectId) ?? null)
      : null,
  )
  // Self-heals a `defaultCwd` left pointing at a dead merge/worktree env folder.
  const localProjectRoot =
    (localProject && getProjectRepoRoot(localProject)) || localProject?.defaultCwd
  const [fileSyncBusy, setFileSyncBusy] = useState(false)
  const [fileSyncStatus, setFileSyncStatus] = useState<string | null>(null)
  const syncProjectNow = async () => {
    if (!otherMember || source.kind !== 'project' || !localProjectRoot) return
    setFileSyncBusy(true)
    setFileSyncStatus(null)
    try {
      await syncFilePipelineOfferProject(otherMember.accountRoute, localProjectRoot)
      setFileSyncStatus(t('chat.fileSync.offered'))
    } catch (cause) {
      console.error('[chat] syncFilePipelineOfferProject failed', cause)
      setFileSyncStatus(t('chat.fileSync.error'))
    } finally {
      setFileSyncBusy(false)
    }
  }
  const [draft, setDraft] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [contactInfoOpen, setContactInfoOpen] = useState(false)
  // Inline rename in the contact-info panel, replacing the native `window.prompt()` this used to
  // call straight through to — a raw browser dialog ("localhost:1422 diz…") looks like a bug in a
  // desktop app, not a feature.
  const [contactRenaming, setContactRenaming] = useState(false)
  const [contactRenameDraft, setContactRenameDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const visibleMessages = useMemo(() => {
    if (!searchOpen || !searchQuery.trim()) return messages
    const query = searchQuery.trim().toLowerCase()
    return messages.filter((message) => message.text.toLowerCase().includes(query))
  }, [messages, searchOpen, searchQuery])
  const [contentType, setContentType] = useState<MessageContentType>('text')
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  // Files pasted/picked are staged here instead of uploading immediately — pinned as small
  // previews above the composer so the caption (the `draft` text) can still be typed before
  // they're actually sent, instead of each file going out the instant it's pasted with no way to
  // say anything alongside it. A list, not a single slot — pasting/picking several at once used to
  // silently overwrite whichever one was already pinned (reported live).
  const [pendingAttachments, setPendingAttachments] = useState<
    { file: File; previewUrl: string | null }[]
  >([])
  const [pendingLightboxIndex, setPendingLightboxIndex] = useState<number | null>(null)
  const [slashHighlight, setSlashHighlight] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const textInputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [dropActive, setDropActive] = useState(false)

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

  // Closes the contact-info panel when switching to a different conversation — it should never
  // carry over and silently show the previous contact's details on top of a new chat.
  useEffect(() => {
    setContactInfoOpen(false)
    setContactRenaming(false)
  }, [
    source.kind === 'direct'
      ? source.contactAccountRoute
      : source.kind === 'project'
        ? source.projectId
        : null,
  ])

  // Backfills this device's own avatar to the other member every time a direct conversation with
  // them opens — `broadcastAvatarUpdate` (Preferences) only fires the instant the picture is
  // *changed*, so a contact who was offline that moment, or paired afterward, never received it
  // otherwise and stayed stuck on an empty/stale thumbnail forever. Throttled per contact inside
  // `sendAvatarUpdateTo` itself, so this being safe to call on every mount doesn't spam the relay.
  useEffect(() => {
    if (source.kind !== 'direct' || !otherMember) return
    void sendAvatarUpdateTo(
      preferences.profileImageUrl,
      otherMember.accountRoute,
      bytesToBase64(otherMember.x25519PublicKey),
    )
    void sendBioUpdateTo(
      preferences.bio,
      otherMember.accountRoute,
      bytesToBase64(otherMember.x25519PublicKey),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, otherMember?.accountRoute, preferences.profileImageUrl, preferences.bio])

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
          const sorted = sortMessages(list)
          setMessages((current) => (sameMessages(current, sorted) ? current : sorted))
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
            const untagged = untagFrame(frame)
            if (!untagged) continue
            if (untagged.tag === P2P_CHANNEL_CHAT) {
              await syncIngestChatTransportFrame(conversationId, untagged.payload).catch(
                (cause) => {
                  console.error('[chat] failed to ingest p2p frame', cause)
                },
              )
            } else if (untagged.tag === P2P_CHANNEL_FILE_SYNC) {
              await syncFilePipelineIngestFrame(accountRoute, untagged.payload)
                .then((event) => {
                  if (event.type === 'stagingStarted')
                    setFileSyncStatus(t('chat.fileSync.receiving'))
                  else if (event.type === 'syncCompleted')
                    setFileSyncStatus(t('chat.fileSync.received', { path: event.destination }))
                })
                .catch((cause) => {
                  console.error('[chat] failed to ingest file-sync frame', cause)
                  setFileSyncStatus(t('chat.fileSync.error'))
                })
            }
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
            console.warn(
              '[chat] relay message could not be opened/ingested (may be for someone else)',
              cause,
            )
          }
        }
      })()
    })
  }, [conversation, otherMember])

  const removePendingAttachment = (index: number) => {
    setPendingAttachments((current) => {
      const removed = current[index]
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((_, i) => i !== index)
    })
    setPendingLightboxIndex(null)
  }

  const clearAllPendingAttachments = () => {
    setPendingAttachments((current) => {
      for (const item of current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return []
    })
    setPendingLightboxIndex(null)
  }

  // Pins the file above the composer instead of uploading it right away — see
  // `pendingAttachments`. Appends, so pasting/picking several files in a row stages all of them —
  // capped, so a clipboard/selection with dozens of files doesn't queue up a huge sequential
  // upload run (`send` uploads them one at a time) or overwhelm the pinned-chip row.
  const stageAttachment = (file: File) => {
    setPendingAttachments((current) => {
      if (current.length >= MAX_PENDING_ATTACHMENTS) return current
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      return [...current, { file, previewUrl }]
    })
    textInputRef.current?.focus()
  }

  // Native OS drag-and-drop (e.g. dragging an image straight from Explorer or another app window)
  // — previously the only ways to attach an image were the file picker or Ctrl+V. Tauri's own
  // `onDragDropEvent` is required here, not the browser's HTML5 `DataTransfer`/`onDrop`: the
  // webview only ever gives real paths through this native event, never `File` objects with
  // bytes already attached (see the same pattern already used for markdown files in
  // `RightSidebar/index.tsx` and for terminal drops in `useXtermSession.ts`). Each dropped path is
  // read into bytes via `read_binary_file` and wrapped into a `File` so it flows through the exact
  // same `stageAttachment` pipeline as a pasted/picked file.
  useEffect(() => {
    if (!isTauriEnv()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const isOverPanel = (position: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1
      const element = document.elementFromPoint(position.x / dpr, position.y / dpr)
      return Boolean(element && panelRef.current?.contains(element))
    }
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter' || payload.type === 'over') {
          setDropActive(isOverPanel(payload.position))
          return
        }
        if (payload.type === 'leave') {
          setDropActive(false)
          return
        }
        const overPanel = isOverPanel(payload.position)
        setDropActive(false)
        if (!overPanel) return
        for (const path of payload.paths) {
          const name = path.split(/[\\/]/).pop() || path
          void readBinaryFile(path)
            .then((bytes) => {
              stageAttachment(
                new File([bytes.buffer as ArrayBuffer], name, { type: guessMimeFromName(name) }),
              )
            })
            .catch((cause) => {
              console.error('[chat] failed to read dropped file', path, cause)
            })
        }
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
     
  }, [])

  // Wrapped in a correlation id so everything one send causes — the local encrypt, the p2p attempt,
  // the relay fallback and the Rust-side records for all three — shares one key in `alethe.jsonl`.
  // "Did it try to send?" stops being a guess from timestamps and becomes `grep '"corr":"chat.send_…'`.
  const send = () => withCorrelation('chat.send', sendWithin)

  const sendWithin = async () => {
    if (!conversation) return
    if (pendingAttachments.length > 0) {
      const staged = pendingAttachments
      const caption = draft
      clearAllPendingAttachments()
      setDraft('')
      await attachFiles(
        staged.map((s) => s.file),
        caption,
      )
      return
    }
    if (!draft.trim()) return
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
            console.warn(
              `[chat] p2p.send failed mid-send (${elapsed()}), falling back to relay`,
              cause,
            )
            await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
          })
        } else {
          await deliverViaRelay(frame, otherMember.accountRoute, otherMember.x25519PublicKey)
        }
      } else {
        // Saved locally and addressed to nobody. This is the case that used to look identical to a
        // successful send from the outside: the message appears in the thread and no error is
        // shown, but nothing was ever handed to a transport.
        console.warn(
          `[chat] message saved locally only — no recipient route (member=${Boolean(otherMember)} frame=${frame.length})`,
        )
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
          await new Promise((resolve) =>
            setTimeout(resolve, RELAY_DELIVERY_RETRY_DELAYS_MS[attempt]),
          )
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

  // Uploads every file and sends them as ONE message carrying all their attachment references —
  // several files sent together used to become N separate messages (one per file), each its own
  // bubble, cluttering the conversation with a run of near-identical "shared a file" lines instead
  // of the one grouped/grid message a batch of images should read as.
  const attachFiles = async (files: File[], caption?: string) => {
    if (!conversation || files.length === 0) return
    setAttaching(true)
    try {
      const uploaded = await Promise.all(
        files.map(async (file) => {
          const buffer = await file.arrayBuffer()
          const bytes = Array.from(new Uint8Array(buffer))
          const attachment = await syncUploadAttachment(
            conversation.conversationId,
            file.type || 'application/octet-stream',
            bytes,
          )
          return { attachmentId: attachment.attachmentId, name: file.name }
        }),
      )
      // The attachment binaries themselves only ever go through `syncUploadAttachment` above
      // (never the relay — see `MAX_CIPHERTEXT_BYTES`/16KB in `sync_rendezvous.rs`); only this
      // short pointer text is eligible for live P2P/relay delivery, same as any other text
      // message. When there's no caption, the same localized fallback text as before is embedded
      // instead — the renderer treats that exact string as "no caption" (see the message-rendering
      // block below) rather than showing it as a redundant caption underneath the preview/grid.
      const trimmedCaption = caption?.trim()
      const fallbackText =
        uploaded.length === 1
          ? t('chat.attachmentMessage', { name: uploaded[0].name, id: uploaded[0].attachmentId })
          : t('chat.attachmentGroupMessage', { count: uploaded.length })
      const [message, frame] = await syncSendMessageForTransport(
        conversation.conversationId,
        'text',
        encodeAttachmentReferences(uploaded) + (trimmedCaption || fallbackText),
      )
      setMessages((current) => sortMessages([...current, message]))
      setDraft('')
      setContentType('text')
      setSlashToken(null)
      setMentionToken(null)
      setPendingMentionRoutes(new Set())
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
      console.error('[chat] failed to attach file(s)', cause)
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
    <div ref={panelRef} className={`${styles.container} ${dropActive ? styles.dropActive : ''}`}>
      <div
        className={`${styles.header} ${source.kind === 'direct' ? styles.headerClickable : ''}`}
        onClick={source.kind === 'direct' ? () => setContactInfoOpen((open) => !open) : undefined}
        title={source.kind === 'direct' ? t('chat.contactInfo.open') : undefined}
      >
        {searchOpen ? (
          <div className={styles.searchBar} onClick={(event) => event.stopPropagation()}>
            <Search size={13} className={styles.searchIcon} />
            <input
              autoFocus
              className={styles.searchInput}
              value={searchQuery}
              placeholder={t('chat.searchPlaceholder')}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setSearchOpen(false)
                  setSearchQuery('')
                }
              }}
            />
            <button
              type="button"
              className={styles.iconButton}
              title={t('common.close')}
              onClick={() => {
                setSearchOpen(false)
                setSearchQuery('')
              }}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            {source.kind === 'direct' ? (
              <>
                <Avatar
                  src={otherAvatarUrl}
                  initial={
                    otherDisplayLabel
                      ? getProfileInitial(otherDisplayLabel)
                      : initialsFor(otherMember?.accountRoute ?? '')
                  }
                  className={styles.headerDirectAvatar}
                />
                <span className={styles.headerTitle}>{source.contactDisplayLabel}</span>
                <span
                  className={`${styles.e2eBadge} ${styles[`e2eBadge_${connectionState}`]}`}
                  title={
                    connectionState === 'relay' && p2p.natInfo?.local === 'symmetric'
                      ? t('chat.connectionState.symmetricNatHint')
                      : undefined
                  }
                >
                  {t(`chat.connectionState.${connectionState}`)}
                </span>
              </>
            ) : (
              <>
                <span className={styles.headerTitle}>{source.projectName}</span>
                <span
                  className={`${styles.e2eBadge} ${styles[`e2eBadge_${connectionState}`]}`}
                  title={
                    connectionState === 'relay' && p2p.natInfo?.local === 'symmetric'
                      ? t('chat.connectionState.symmetricNatHint')
                      : undefined
                  }
                >
                  {t(`chat.connectionState.${connectionState}`)}
                </span>
              </>
            )}
            {source.kind === 'project' && p2p.state === 'p2p' && localProjectRoot ? (
              <button
                type="button"
                className={styles.headerAction}
                disabled={fileSyncBusy}
                title={fileSyncStatus ?? undefined}
                onClick={(event) => {
                  event.stopPropagation()
                  void syncProjectNow()
                }}
              >
                {fileSyncBusy ? <Loader2 size={13} className={styles.spin} /> : null}
                {t('chat.fileSync.syncNow')}
              </button>
            ) : null}
            {source.kind === 'project' && otherMembers.length > 0 ? (
              <div
                className={styles.headerMembers}
                title={t('chat.headerMembersTitle', { count: otherMembers.length })}
              >
                {otherMembers.slice(0, 4).map((member) => (
                  <Avatar
                    key={member.accountRoute}
                    src={null}
                    initial={initialsFor(member.accountRoute)}
                    className={styles.headerMemberAvatar}
                  />
                ))}
                {otherMembers.length > 4 ? (
                  <span className={styles.headerMemberOverflow}>+{otherMembers.length - 4}</span>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className={styles.headerSearchButton}
              title={t('chat.searchMessages')}
              disabled={!conversation}
              onClick={(event) => {
                event.stopPropagation()
                setSearchOpen(true)
              }}
            >
              <Search size={14} />
            </button>
          </>
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.bodyMain}>
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
            ) : searchOpen && searchQuery.trim() && visibleMessages.length === 0 ? (
              <div className={styles.empty}>
                <Search size={28} className={styles.emptyIcon} />
                <span>{t('chat.searchNoMatch')}</span>
              </div>
            ) : (
              visibleMessages.map((message) => {
                const own = message.senderDeviceId === localDeviceId
                return (
                  <div
                    key={message.messageId}
                    className={`${styles.messageRow} ${own ? styles.messageRowOwn : ''}`}
                  >
                    <div className={styles.avatar}>
                      {own ? (
                        <Avatar
                          src={ownAvatarUrl}
                          initial={ownInitial}
                          className={styles.avatarImg}
                        />
                      ) : (
                        <Avatar
                          src={otherAvatarUrl}
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
                      ) : message.contentType === 'text' &&
                        parseAttachmentReferences(message.text) &&
                        conversation ? (
                        (() => {
                          const parsed = parseAttachmentReferences(message.text)!
                          const [attachment] = parsed.attachments
                          // The auto-generated fallback text (no real caption typed) must not be
                          // shown again as a redundant caption line under a preview that already
                          // displays the filename(s) itself.
                          const fallback =
                            parsed.attachments.length > 1
                              ? t('chat.attachmentGroupMessage', {
                                  count: parsed.attachments.length,
                                })
                              : t('chat.attachmentMessage', {
                                  name: attachment.name,
                                  id: attachment.attachmentId,
                                })
                          const caption = parsed.rest !== fallback ? parsed.rest : undefined
                          return parsed.attachments.length > 1 ? (
                            <AttachmentGrid
                              conversationId={conversation.conversationId}
                              attachments={parsed.attachments}
                              caption={caption}
                            />
                          ) : (
                            <AttachmentPreview
                              conversationId={conversation.conversationId}
                              attachmentId={attachment.attachmentId}
                              name={attachment.name}
                              caption={caption}
                            />
                          )
                        })()
                      ) : (
                        <p
                          className={`${styles.messageText} ${own ? styles.bubbleOwn : styles.bubbleOther}`}
                        >
                          {renderMessageText(message.text, searchOpen ? searchQuery : '')}
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
            {pendingAttachments.length > 0 ? (
              <div className={styles.pendingAttachmentRow}>
                {pendingAttachments.map((pending, index) => (
                  <div key={index} className={styles.pendingAttachment}>
                    <button
                      type="button"
                      className={styles.pendingAttachmentPreviewTrigger}
                      disabled={!pending.previewUrl}
                      onClick={() => setPendingLightboxIndex(index)}
                      title={pending.previewUrl ? t('chat.viewFullSize') : undefined}
                    >
                      {pending.previewUrl ? (
                        <img
                          src={pending.previewUrl}
                          alt=""
                          className={styles.pendingAttachmentThumb}
                        />
                      ) : (
                        <Paperclip size={14} />
                      )}
                      <span className={styles.pendingAttachmentName}>{pending.file.name}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.pendingAttachmentClear}
                      onClick={() => removePendingAttachment(index)}
                      title={t('common.remove')}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {pendingLightboxIndex !== null
              ? (() => {
                  const previewable = pendingAttachments
                    .map((p, index) => ({ p, index }))
                    .filter(({ p }) => p.previewUrl && previewKindFor(p.file.name))
                  if (previewable.length === 0) return null
                  const items = previewable.map(({ p }) => ({
                    src: p.previewUrl!,
                    kind: previewKindFor(p.file.name)!,
                    alt: p.file.name,
                  }))
                  const targetPos = previewable.findIndex(
                    ({ index }) => index === pendingLightboxIndex,
                  )
                  const clampedIndex = targetPos >= 0 ? targetPos : 0
                  return (
                    <Lightbox
                      items={items}
                      initialIndex={clampedIndex}
                      onClose={() => setPendingLightboxIndex(null)}
                    />
                  )
                })()
              : null}
            <div className={styles.composerRow}>
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
                    if (
                      event.key.startsWith('Arrow') ||
                      event.key === 'Home' ||
                      event.key === 'End'
                    ) {
                      const { value, selectionStart } = event.currentTarget
                      updateSlashToken(value, selectionStart ?? value.length)
                      updateMentionToken(value, selectionStart ?? value.length)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (mentionMenuOpen && !slashMenuOpen) {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setMentionHighlight(
                          (current) => (current + 1) % Math.max(mentionMatches.length, 1),
                        )
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
                        setSlashHighlight(
                          (current) => (current + 1) % Math.max(slashMatches.length, 1),
                        )
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
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.items)
                      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                      .map((item) => item.getAsFile())
                      .filter((file): file is File => file !== null)
                    if (files.length === 0) return
                    // A pasted image has no filename from the clipboard — text keeps flowing into the
                    // draft as usual, only the image(s) themselves are intercepted and pinned above the
                    // composer (see `stageAttachment`) instead of uploading immediately. Every pasted
                    // image is staged, not just the first — pasting several at once used to silently
                    // overwrite whichever one was already pinned.
                    event.preventDefault()
                    for (const file of files) stageAttachment(file)
                  }}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className={styles.hiddenFileInput}
                  onChange={(event) => {
                    for (const file of Array.from(event.target.files ?? [])) stageAttachment(file)
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
                  {attaching ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <Paperclip size={14} />
                  )}
                </button>
              </div>
              <button
                type="button"
                className={styles.sendButton}
                disabled={
                  sending ||
                  attaching ||
                  (!draft.trim() && pendingAttachments.length === 0) ||
                  !conversation
                }
                onClick={() => void send()}
              >
                {sending || attaching ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Send size={14} />
                )}
              </button>
            </div>
          </div>
        </div>

        {contactInfoOpen && source.kind === 'direct' ? (
          <div className={styles.contactInfoPanel}>
            <div className={styles.contactInfoHeader}>
              <button
                type="button"
                className={styles.iconButton}
                title={t('common.close')}
                onClick={() => setContactInfoOpen(false)}
              >
                <X size={14} />
              </button>
              <span className={styles.contactInfoTitle}>{t('chat.contactInfo.title')}</span>
              {contactActions && !contactRenaming ? (
                <button
                  type="button"
                  className={styles.iconButton}
                  title={t('chat.contacts.rename')}
                  onClick={() => {
                    setContactRenameDraft(source.contactDisplayLabel)
                    setContactRenaming(true)
                  }}
                >
                  <Pencil size={14} />
                </button>
              ) : (
                <span className={styles.iconButtonSpacer} />
              )}
            </div>
            <div className={styles.contactInfoIdentity}>
              <Avatar
                src={otherAvatarUrl}
                initial={
                  otherDisplayLabel
                    ? getProfileInitial(otherDisplayLabel)
                    : initialsFor(otherMember?.accountRoute ?? '')
                }
                className={styles.contactInfoAvatar}
              />
              {contactRenaming && contactActions ? (
                <form
                  className={styles.contactInfoRenameForm}
                  onSubmit={(event) => {
                    event.preventDefault()
                    const trimmed = contactRenameDraft.trim()
                    if (trimmed && trimmed !== source.contactDisplayLabel)
                      contactActions.onRename(trimmed)
                    setContactRenaming(false)
                  }}
                >
                  <input
                    autoFocus
                    className={styles.contactInfoRenameInput}
                    value={contactRenameDraft}
                    maxLength={80}
                    onChange={(event) => setContactRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setContactRenaming(false)
                      }
                    }}
                    onBlur={() => setContactRenaming(false)}
                  />
                </form>
              ) : (
                <span className={styles.contactInfoName}>{source.contactDisplayLabel}</span>
              )}
              <span className={styles.contactInfoStatus}>
                {t(`chat.connectionState.${connectionState}`)}
              </span>
              {source.contactBio ? (
                <p className={styles.contactInfoBio}>{source.contactBio}</p>
              ) : null}
            </div>
            {contactActions ? (
              <div className={styles.contactInfoActions}>
                <InviteToProject contactAccountRoute={source.contactAccountRoute} />
                <button
                  type="button"
                  className={`${styles.contactInfoAction} ${styles.contactInfoActionDanger}`}
                  onClick={() => contactActions.onDeleteAll()}
                >
                  <Eraser size={14} />
                  {t('chat.contacts.deleteAll')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

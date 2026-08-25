import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type ConversationKind = 'direct' | 'project_channel' | 'private_group'
export type MessageContentType = 'text' | 'code_block' | 'test_result' | 'bug_report' | 'command'

export type MemberInfo = { accountRoute: string; x25519PublicKey: number[] }

export type Conversation = {
  conversationId: string
  projectId: string | null
  kind: ConversationKind
  category: string | null
  members: MemberInfo[]
  createdAtMs: number
  updatedAtMs: number
}

export type Reaction = { memberAccountRoute: string; emoji: string }

export type DecryptedMessage = {
  messageId: string
  conversationId: string
  sequence: number
  senderDeviceId: string
  senderAccountRoute: string
  contentType: MessageContentType
  text: string
  mentions: string[]
  reactions: Reaction[]
  createdAtMs: number
  editedAtMs?: number
}

export type AttachmentRecord = {
  attachmentId: string
  conversationId: string
  declaredContentType: string
  declaredSize: number
  actualSize: number
  contentHash: string
  createdAtMs: number
}

export async function syncEnsureProjectConversation(projectId: string): Promise<Conversation> {
  if (isTauriEnv()) return invoke<Conversation>('sync_ensure_project_conversation', { projectId })
  return webApiFetch<Conversation>('/api/sync/chat/conversations/ensure-project', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

export async function syncStartDirectConversation(
  contactAccountRoute: string,
): Promise<Conversation> {
  if (isTauriEnv())
    return invoke<Conversation>('sync_start_direct_conversation', { contactAccountRoute })
  return webApiFetch<Conversation>('/api/sync/chat/conversations/start-direct', {
    method: 'POST',
    body: JSON.stringify({ contactAccountRoute }),
  })
}

export async function syncSendMessage(
  conversationId: string,
  contentType: MessageContentType,
  text: string,
  mentions: string[] = [],
): Promise<DecryptedMessage> {
  if (isTauriEnv()) {
    return invoke<DecryptedMessage>('sync_send_message', {
      conversationId,
      contentType,
      text,
      mentions,
    })
  }
  return webApiFetch<DecryptedMessage>('/api/sync/chat/messages/send', {
    method: 'POST',
    body: JSON.stringify({ conversationId, contentType, text, mentions }),
  })
}

export async function syncListDecryptedMessages(
  conversationId: string,
): Promise<DecryptedMessage[]> {
  if (isTauriEnv()) {
    return invoke<DecryptedMessage[]>('sync_list_decrypted_messages', { conversationId })
  }
  const params = new URLSearchParams({ conversationId })
  return webApiFetch<DecryptedMessage[]>(`/api/sync/chat/messages/decrypted?${params.toString()}`)
}

export async function syncDeleteMessage(conversationId: string, messageId: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke('sync_delete_message', { conversationId, messageId })
    return
  }
  await webApiFetch<void>('/api/sync/chat/messages/delete', {
    method: 'POST',
    body: JSON.stringify({ conversationId, messageId }),
  })
}

export async function syncUploadAttachment(
  conversationId: string,
  declaredContentType: string,
  bytes: number[],
): Promise<AttachmentRecord> {
  if (isTauriEnv()) {
    return invoke<AttachmentRecord>('sync_upload_attachment', {
      conversationId,
      declaredContentType,
      bytes,
    })
  }
  return webApiFetch<AttachmentRecord>('/api/sync/chat/attachments/upload', {
    method: 'POST',
    body: JSON.stringify({ conversationId, declaredContentType, bytes }),
  })
}

export async function syncDownloadAttachment(
  conversationId: string,
  attachmentId: string,
): Promise<number[]> {
  if (isTauriEnv()) {
    return invoke<number[]>('sync_download_attachment', { conversationId, attachmentId })
  }
  const params = new URLSearchParams({ conversationId, attachmentId })
  return webApiFetch<number[]>(`/api/sync/chat/attachments/download?${params.toString()}`)
}

/**
 * Same as `syncSendMessage`, plus the raw (still-encrypted) `MessageRecord` as bytes — hand that
 * to `p2pSendFrame` or `syncSealChatRelayMessage` for live cross-device delivery, then
 * `syncIngestChatTransportFrame` on the receiving side.
 */
export async function syncSendMessageForTransport(
  conversationId: string,
  contentType: MessageContentType,
  text: string,
  mentions: string[] = [],
): Promise<[DecryptedMessage, number[]]> {
  if (isTauriEnv()) {
    return invoke<[DecryptedMessage, number[]]>('sync_send_message_for_transport', {
      conversationId,
      contentType,
      text,
      mentions,
    })
  }
  const message = await webApiFetch<DecryptedMessage>('/api/sync/chat/messages/send', {
    method: 'POST',
    body: JSON.stringify({ conversationId, contentType, text, mentions }),
  })
  return [message, []]
}

/** Persists a `MessageRecord` frame received over P2P or the relay, exactly like a locally-sent
 * message (idempotent by message ID), and returns it decrypted for immediate display. */
export async function syncIngestChatTransportFrame(
  conversationId: string,
  frame: number[],
): Promise<DecryptedMessage> {
  if (!isTauriEnv()) throw new Error('chat_transport_desktop_only')
  return invoke<DecryptedMessage>('sync_ingest_chat_transport_frame', { conversationId, frame })
}

/**
 * Chat relay fallback (Desktop-only, same reasoning as `p2pBridge.ts`): encrypts an already-JSON
 * `DecryptedMessage` for a single member's X25519 key, ready to send through the rendezvous relay
 * as `{ type: 'enqueue', kind: 'chat_message' }` when a direct P2P session isn't connected yet.
 */
export async function syncSealChatRelayMessage(
  plaintext: number[],
  recipientAgreementPublicKey: string,
): Promise<string> {
  if (!isTauriEnv()) throw new Error('chat_relay_desktop_only')
  return invoke<string>('sync_seal_chat_relay_message', {
    plaintext,
    recipientAgreementPublicKey,
  })
}

export async function syncOpenChatRelayMessage(ciphertext: string): Promise<number[]> {
  if (!isTauriEnv()) throw new Error('chat_relay_desktop_only')
  return invoke<number[]>('sync_open_chat_relay_message', { ciphertext })
}

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

export async function syncListDecryptedMessages(conversationId: string): Promise<DecryptedMessage[]> {
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

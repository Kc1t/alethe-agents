import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

/**
 * Per-conversation storage breakdown (see `sync_chat.rs`'s `ConversationStorageUsage`) — one row
 * per local conversation file. Attachments live embedded inside each conversation's own document
 * (no separate per-attachment file), so this is a scan, not a lookup; the frontend groups these
 * rows by project or by contact since name resolution already lives in the stores that already
 * have that data (`projectsStore`, `syncListChatContacts`).
 */
export type ConversationStorageUsage = {
  conversationId: string
  kind: 'direct' | 'project_channel' | 'private_group'
  projectId: string | null
  /** The other member's account route, for a `direct` conversation only. */
  otherAccountRoute: string | null
  messageBytes: number
  imageBytes: number
  videoBytes: number
  otherBytes: number
}

export type AttachmentCategory = 'image' | 'video' | 'other'

export async function syncStorageUsage(): Promise<ConversationStorageUsage[]> {
  if (!isTauriEnv()) return []
  return invoke('sync_storage_usage')
}

/** Strips every attachment of `category` from one conversation — message text/history is
 * untouched, only the referenced attachment bytes are removed. Returns the number of bytes freed. */
export async function syncStorageCleanupAttachments(
  conversationId: string,
  category: AttachmentCategory,
): Promise<number> {
  if (!isTauriEnv()) throw new Error('storage_cleanup_desktop_only')
  return invoke('sync_storage_cleanup_attachments', { conversationId, category })
}

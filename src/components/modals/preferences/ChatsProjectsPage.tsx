import { Film, Image as ImageIcon, Loader2, MessageSquare, Paperclip, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { syncListChatContacts } from '../../../lib/api/syncSecurity'
import {
  type AttachmentCategory,
  type ConversationStorageUsage,
  syncStorageCleanupAttachments,
  syncStorageClearMessages,
  syncStorageUsage,
} from '../../../lib/api/syncStorageUsage'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import styles from './ChatsProjectsPage.module.css'
import { SettingsSection } from './primitives'

/** One row per project (grouping every `ProjectChannel`/`PrivateGroup` conversation that shares a
 * `projectId`, or standing alone by `conversationId` if it has none) or per direct contact
 * (grouping by `otherAccountRoute`) — the breakdown the "Chats & Projetos" tab shows, with a
 * per-category cleanup action. Attachments live embedded inside each conversation's own document
 * (`sync_chat.rs`), so cleanup always targets specific conversation ids, never a bare "project"
 * concept the backend doesn't otherwise track. */
type StorageGroup = {
  key: string
  label: string
  kind: 'project' | 'direct'
  conversationIds: string[]
  messageBytes: number
  imageBytes: number
  videoBytes: number
  otherBytes: number
}

function totalBytes(group: StorageGroup): number {
  return group.messageBytes + group.imageBytes + group.videoBytes + group.otherBytes
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function ChatsProjectsPage() {
  const t = useT()
  const projects = useProjectsStore((state) => state.projects)
  const [rows, setRows] = useState<ConversationStorageUsage[] | null>(null)
  const [contactLabels, setContactLabels] = useState<Record<string, string>>({})
  const [error, setError] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const refresh = async () => {
    setError(false)
    try {
      const [usage, contacts] = await Promise.all([syncStorageUsage(), syncListChatContacts()])
      setRows(usage)
      setContactLabels(Object.fromEntries(contacts.map((contact) => [contact.accountRoute, contact.displayLabel])))
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = useMemo<StorageGroup[]>(() => {
    if (!rows) return []
    const byKey = new Map<string, StorageGroup>()
    for (const row of rows) {
      const isDirect = row.kind === 'direct'
      if (!isDirect && row.projectId && !projects.some((project) => project.id === row.projectId)) {
        // Skip orphan conversations for projects that have been removed/deleted from the workspace.
        continue
      }
      const key = isDirect ? `direct:${row.otherAccountRoute ?? row.conversationId}` : `project:${row.projectId ?? row.conversationId}`
      const label = isDirect
        ? (row.otherAccountRoute && contactLabels[row.otherAccountRoute]) || row.otherAccountRoute || t('prefs.chatsProjects.unknownContact')
        : (row.projectId && projects.find((project) => project.id === row.projectId)?.name) ||
          row.projectId ||
          t('prefs.chatsProjects.unknownProject')
      const existing = byKey.get(key)
      if (existing) {
        existing.conversationIds.push(row.conversationId)
        existing.messageBytes += row.messageBytes
        existing.imageBytes += row.imageBytes
        existing.videoBytes += row.videoBytes
        existing.otherBytes += row.otherBytes
      } else {
        byKey.set(key, {
          key,
          label,
          kind: isDirect ? 'direct' : 'project',
          conversationIds: [row.conversationId],
          messageBytes: row.messageBytes,
          imageBytes: row.imageBytes,
          videoBytes: row.videoBytes,
          otherBytes: row.otherBytes,
        })
      }
    }
    return Array.from(byKey.values()).sort((a, b) => totalBytes(b) - totalBytes(a))
  }, [rows, contactLabels, projects, t])

  const cleanup = async (group: StorageGroup, category: AttachmentCategory) => {
    setBusyKey(`${group.key}:${category}`)
    setError(false)
    try {
      await Promise.all(group.conversationIds.map((conversationId) => syncStorageCleanupAttachments(conversationId, category)))
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusyKey(null)
    }
  }

  const clearMessages = async (group: StorageGroup) => {
    if (!window.confirm(t('prefs.chatsProjects.clearMessagesConfirm'))) return
    setBusyKey(`${group.key}:messages`)
    setError(false)
    try {
      await Promise.all(group.conversationIds.map((conversationId) => syncStorageClearMessages(conversationId)))
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusyKey(null)
    }
  }

  // Deliberately gated behind a confirmation (see `clearMessages`) — unlike attachments, this
  // clears conversation history, not disposable media, so a plain click is one step too easy for
  // something this hard to undo.
  const messageRow = (group: StorageGroup, bytes: number) => {
    if (bytes === 0) return null
    const busy = busyKey === `${group.key}:messages`
    return (
      <div className={styles.categoryRow}>
        <MessageSquare size={13} aria-hidden="true" />
        <span className={styles.categoryLabel}>{t('prefs.chatsProjects.categoryMessages')}</span>
        <span className={styles.categoryBytes}>{formatBytes(bytes)}</span>
        <button
          type="button"
          className={styles.categoryClear}
          disabled={busy}
          title={t('prefs.chatsProjects.clearMessages')}
          onClick={() => void clearMessages(group)}
        >
          {busy ? <Loader2 size={12} className={styles.spin} /> : <Trash2 size={12} />}
        </button>
      </div>
    )
  }

  const categoryRow = (
    group: StorageGroup,
    category: AttachmentCategory,
    bytes: number,
    Icon: typeof ImageIcon,
    label: string,
  ) => {
    if (bytes === 0) return null
    const busy = busyKey === `${group.key}:${category}`
    return (
      <div className={styles.categoryRow}>
        <Icon size={13} aria-hidden="true" />
        <span className={styles.categoryLabel}>{label}</span>
        <span className={styles.categoryBytes}>{formatBytes(bytes)}</span>
        <button
          type="button"
          className={styles.categoryClear}
          disabled={busy}
          title={t('prefs.chatsProjects.clearCategory', { category: label })}
          onClick={() => void cleanup(group, category)}
        >
          {busy ? <Loader2 size={12} className={styles.spin} /> : <Trash2 size={12} />}
        </button>
      </div>
    )
  }

  return (
    <>
      <SettingsSection
        id="chats-projects-storage"
        title={t('prefs.chatsProjects.storageTitle')}
        description={t('prefs.chatsProjects.storageDesc')}
      >
        {error ? <p className={controls.hint}>{t('prefs.chatsProjects.error')}</p> : null}
        {!rows ? (
          <div className={styles.loading}>
            <Loader2 size={16} className={styles.spin} />
          </div>
        ) : groups.length === 0 ? (
          <p className={controls.hint}>{t('prefs.chatsProjects.empty')}</p>
        ) : (
          <div className={styles.groupList}>
            {groups.map((group) => (
              <div key={group.key} className={styles.group}>
                <div className={styles.groupHeader}>
                  <span className={styles.groupBadge}>
                    {t(group.kind === 'project' ? 'prefs.chatsProjects.kindProject' : 'prefs.chatsProjects.kindDirect')}
                  </span>
                  <span className={styles.groupLabel}>{group.label}</span>
                  <span className={styles.groupTotal}>{formatBytes(totalBytes(group))}</span>
                </div>
                <div className={styles.categories}>
                  {messageRow(group, group.messageBytes)}
                  {categoryRow(group, 'image', group.imageBytes, ImageIcon, t('prefs.chatsProjects.categoryImage'))}
                  {categoryRow(group, 'video', group.videoBytes, Film, t('prefs.chatsProjects.categoryVideo'))}
                  {categoryRow(group, 'other', group.otherBytes, Paperclip, t('prefs.chatsProjects.categoryOther'))}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </>
  )
}

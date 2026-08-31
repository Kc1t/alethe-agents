import { Bell, Hash, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { subscribeToRendezvousEvents } from '../../lib/api/rendezvousEventBus'
import { syncDeleteDirectConversation } from '../../lib/api/syncChat'
import { connectRendezvous, getRendezvousStatus } from '../../lib/api/syncRendezvous'
import {
  type SyncChatContact,
  syncListChatContacts,
  syncListPendingChatContactRequests,
  syncOpenAvatarUpdate,
  syncOpenBioUpdate,
  syncOpenChatContactAck,
  syncRemoveChatContact,
  syncRenameChatContact,
} from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { DEFAULT_PROFILE_IMAGE_URL, getProfileInitial } from '../../lib/profile'
import { Avatar } from '../ui/Avatar'
import { AddChatContactModal } from './AddChatContactModal'
import { ChatPanel, type ChatSource } from './ChatPanel'
import styles from './ChatTab.module.css'
import { PairingRequestsPanel } from './PairingRequestsPanel'

const CONTACT_ACK_POLL_INTERVAL_MS = 4_000

export function ChatTab({
  projectId,
  projectName,
}: {
  projectId: string | null
  projectName: string | null
}) {
  const t = useT()
  const [contacts, setContacts] = useState<SyncChatContact[]>([])
  const [contactsError, setContactsError] = useState(false)
  const [selected, setSelected] = useState<ChatSource | null>(
    projectId && projectName ? { kind: 'project', projectId, projectName } : null,
  )
  const [addingContact, setAddingContact] = useState(false)
  const [showPairingRequests, setShowPairingRequests] = useState(false)
  const [pendingRequestCount, setPendingRequestCount] = useState(0)

  const reloadPendingRequestCount = () => {
    syncListPendingChatContactRequests()
      .then((list) => setPendingRequestCount(list.length))
      .catch(() => undefined)
  }

  const renameContact = async (contact: SyncChatContact, nextLabel: string) => {
    if (!nextLabel || nextLabel === contact.displayLabel) return
    try {
      await syncRenameChatContact(contact.accountRoute, nextLabel)
      if (selected?.kind === 'direct' && selected.contactAccountRoute === contact.accountRoute) {
        setSelected({ ...selected, contactDisplayLabel: nextLabel })
      }
      reloadContacts()
    } catch {
      setContactsError(true)
    }
  }

  const clearSelectionIfCurrent = (accountRoute: string) => {
    if (selected?.kind === 'direct' && selected.contactAccountRoute === accountRoute) {
      setSelected(projectId && projectName ? { kind: 'project', projectId, projectName } : null)
    }
  }

  const deleteContactAndHistory = async (contact: SyncChatContact) => {
    if (!window.confirm(t('chat.contacts.deleteAllConfirm'))) return
    try {
      await syncRemoveChatContact(contact.accountRoute)
      await syncDeleteDirectConversation(contact.accountRoute)
      clearSelectionIfCurrent(contact.accountRoute)
      reloadContacts()
    } catch (cause) {
      console.error('[chat-contact] deleteContactAndHistory failed', cause)
      setContactsError(true)
    }
  }

  const reloadContacts = () => {
    syncListChatContacts()
      .then((list) => {
        setContacts(list)
        setContactsError(false)
        // A previously-selected direct conversation can go stale (its contact was removed, e.g.
        // via the trash icon, possibly from a different tab/session) — keeping it selected would
        // make the next open attempt fail with `chat_contact_not_found`. Fall back instead of
        // leaving a dead reference around.
        setSelected((current) => {
          if (current?.kind !== 'direct') return current
          const stillExists = list.some(
            (contact) => contact.accountRoute === current.contactAccountRoute,
          )
          if (stillExists) return current
          return projectId && projectName ? { kind: 'project', projectId, projectName } : null
        })
      })
      .catch(() => setContactsError(true))
  }

  useEffect(() => {
    reloadContacts()
  }, [])

  useEffect(() => {
    if (projectId && projectName) setSelected({ kind: 'project', projectId, projectName })
  }, [projectId, projectName])

  // With no active project, default to the first chat contact once contacts load — there's no
  // project channel to fall back to in that case.
  useEffect(() => {
    if (!projectId && !selected && contacts.length > 0) {
      const contact = contacts[0]
      setSelected({
        kind: 'direct',
        contactAccountRoute: contact.accountRoute,
        contactDisplayLabel: contact.displayLabel,
        contactAvatarThumbnail: contact.avatarThumbnail,
        contactBio: contact.bio,
      })
    }
  }, [projectId, selected, contacts])

  // Keeps the relay connected even before a first contact (and therefore ChatPanel, which is what
  // normally establishes it) exists — without this, a brand-new device with zero contacts would
  // never actually connect, and the mutual auto-add-back ack from someone who just added them
  // would silently never arrive.
  useEffect(() => {
    const ensureConnected = async () => {
      try {
        const status = await getRendezvousStatus()
        if (status.state === 'no_attempt_yet') {
          await connectRendezvous().catch((cause) => {
            console.error('[chat-contact] ack-loop reconnect failed', cause)
          })
        }
      } catch (cause) {
        console.error('[chat-contact] getRendezvousStatus (ack loop) failed', cause)
      }
    }
    void ensureConnected()
    const timer = window.setInterval(() => void ensureConnected(), CONTACT_ACK_POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  // Handles any `chat_contact_ack` deliveries from the shared event bus (see
  // `rendezvousEventBus.ts` — calling `drainRendezvousEvents()` directly here used to race with
  // ChatPanel's own listener and silently steal/discard whichever event wasn't its own kind) —
  // someone who just verified and saved our exported invite code on their own device. Decrypting
  // it (if its token is still valid) queues a pairing request for review instead of adding them
  // automatically — see `PairingRequestsPanel.tsx` for where the actual decision happens.
  useEffect(() => {
    let active = true
    const unsubscribe = subscribeToRendezvousEvents((events) => {
      const ackEvents = events.filter((event) => event.envelopeKind === 'chat_contact_ack')
      if (ackEvents.length === 0) return
      console.info('[chat-contact] chat_contact_ack envelopes received', ackEvents.length)
      void (async () => {
        let queued = false
        for (const event of ackEvents) {
          if (event.eventType !== 'delivery' || !event.ciphertext) continue
          try {
            const result = await syncOpenChatContactAck(event.ciphertext)
            if (result) {
              queued = true
              console.info('[chat-contact] queued pairing request from', result.displayLabel)
            } else {
              console.warn('[chat-contact] ack token did not match any live token (stale/reused?)')
            }
          } catch (cause) {
            // Not addressed to this device — but could also be a real bug, so log instead of hiding.
            console.warn('[chat-contact] ack could not be opened (may be addressed to someone else)', cause)
          }
        }
        if (active && queued) reloadPendingRequestCount()
      })()
    })
    return () => {
      active = false
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    reloadPendingRequestCount()
    const timer = window.setInterval(reloadPendingRequestCount, 15_000)
    return () => window.clearInterval(timer)
  }, [])

  // Keeps a contact's avatar live: whenever they change their profile picture, their device sends
  // an `avatar_update` envelope to every contact of theirs (see `AccountPage.tsx`). Reload the
  // contact list so the new thumbnail shows immediately instead of only appearing after some
  // unrelated refresh.
  useEffect(() => {
    let active = true
    const unsubscribe = subscribeToRendezvousEvents((events) => {
      const profileEvents = events.filter(
        (event) => event.envelopeKind === 'avatar_update' || event.envelopeKind === 'bio_update',
      )
      if (profileEvents.length === 0) return
      void (async () => {
        let updated = false
        for (const event of profileEvents) {
          if (event.eventType !== 'delivery' || !event.ciphertext) continue
          try {
            const accountRoute =
              event.envelopeKind === 'avatar_update'
                ? await syncOpenAvatarUpdate(event.ciphertext)
                : await syncOpenBioUpdate(event.ciphertext)
            if (accountRoute) updated = true
          } catch (cause) {
            console.warn(`[chat-contact] ${event.envelopeKind} could not be opened`, cause)
          }
        }
        if (active && updated) reloadContacts()
      })()
    })
    return () => {
      active = false
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (selected?.kind === 'direct') {
      const match = contacts.find((c) => c.accountRoute === selected.contactAccountRoute)
      if (
        match &&
        (match.displayLabel !== selected.contactDisplayLabel ||
          match.avatarThumbnail !== selected.contactAvatarThumbnail ||
          match.bio !== selected.contactBio)
      ) {
        setSelected({
          kind: 'direct',
          contactAccountRoute: match.accountRoute,
          contactDisplayLabel: match.displayLabel,
          contactAvatarThumbnail: match.avatarThumbnail,
          contactBio: match.bio,
        })
      }
    }
  }, [contacts, selected])

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span>{t('chat.contacts.title')}</span>
          <div className={styles.sidebarHeaderActions}>
            <button
              type="button"
              className={styles.addButton}
              title={t('pairingRequests.badgeTitle')}
              onClick={() => setShowPairingRequests(true)}
            >
              <Bell size={13} />
              {pendingRequestCount > 0 ? (
                <span className={styles.pendingBadge}>{pendingRequestCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={styles.addButton}
              title={t('chat.contacts.add')}
              onClick={() => setAddingContact(true)}
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
        <ul className={styles.conversationList}>
          {projectId && projectName ? (
            <li>
              <button
                type="button"
                className={`${styles.conversationRow} ${selected?.kind === 'project' ? styles.conversationRowActive : ''}`}
                onClick={() => setSelected({ kind: 'project', projectId, projectName })}
              >
                <span className={styles.channelIcon}>
                  <Hash size={14} />
                </span>
                <span className={styles.conversationName}>{projectName}</span>
              </button>
            </li>
          ) : null}
          {contacts.map((contact) => {
            const active =
              selected?.kind === 'direct' && selected.contactAccountRoute === contact.accountRoute
            return (
              <li key={contact.accountRoute} className={styles.conversationItem}>
                <button
                  type="button"
                  className={`${styles.conversationRow} ${active ? styles.conversationRowActive : ''}`}
                  onClick={() =>
                    setSelected({
                      kind: 'direct',
                      contactAccountRoute: contact.accountRoute,
                      contactDisplayLabel: contact.displayLabel,
                      contactAvatarThumbnail: contact.avatarThumbnail,
                      contactBio: contact.bio,
                    })
                  }
                >
                  <Avatar
                    // Same fallback as `ChatPanel.tsx`'s own avatar handling: the app's default
                    // icon when there's no real photo synced yet, not a bare initial — keeps "no
                    // photo set" looking the same everywhere instead of only in the open
                    // conversation view.
                    src={contact.avatarThumbnail || DEFAULT_PROFILE_IMAGE_URL}
                    initial={getProfileInitial(contact.displayLabel)}
                    className={styles.contactAvatar}
                  />
                  <span className={styles.conversationName}>{contact.displayLabel}</span>
                </button>
              </li>
            )
          })}
        </ul>
        {contactsError ? (
          <p className={styles.contactsError}>{t('chat.contacts.listFailed')}</p>
        ) : null}
        <p className={styles.chatOnlyNotice}>{t('chat.contacts.chatOnlyNotice')}</p>
      </div>
      <div className={styles.chatArea}>
        {selected ? (
          <ChatPanel
            key={selected.kind === 'project' ? 'project' : selected.contactAccountRoute}
            source={selected}
            contactActions={
              selected.kind === 'direct'
                ? {
                    onRename: (newDisplayLabel: string) => {
                      const contact = contacts.find((item) => item.accountRoute === selected.contactAccountRoute)
                      if (contact) void renameContact(contact, newDisplayLabel)
                    },
                    onDeleteAll: () => {
                      const contact = contacts.find((item) => item.accountRoute === selected.contactAccountRoute)
                      if (contact) void deleteContactAndHistory(contact)
                    },
                  }
                : undefined
            }
          />
        ) : (
          <div className={styles.emptyChat}>{t('chat.contacts.empty')}</div>
        )}
      </div>
      {addingContact ? (
        <AddChatContactModal
          onClose={() => setAddingContact(false)}
          onAdded={() => {
            setAddingContact(false)
            reloadContacts()
          }}
        />
      ) : null}
      {showPairingRequests ? (
        <PairingRequestsPanel
          onClose={() => {
            setShowPairingRequests(false)
            reloadContacts()
            reloadPendingRequestCount()
          }}
        />
      ) : null}
    </div>
  )
}

import { Eraser, Hash, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { subscribeToRendezvousEvents } from '../../lib/api/rendezvousEventBus'
import { syncDeleteDirectConversation } from '../../lib/api/syncChat'
import { connectRendezvous, getRendezvousStatus } from '../../lib/api/syncRendezvous'
import {
  type SyncChatContact,
  syncListChatContacts,
  syncOpenChatContactAck,
  syncRemoveChatContact,
  syncRenameChatContact,
} from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { getProfileInitial } from '../../lib/profile'
import { Avatar } from '../ui/Avatar'
import { AddChatContactModal } from './AddChatContactModal'
import { ChatPanel, type ChatSource } from './ChatPanel'
import styles from './ChatTab.module.css'

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

  const renameContact = async (contact: SyncChatContact) => {
    const input = window.prompt(t('chat.contacts.renamePrompt'), contact.displayLabel)
    const nextLabel = input?.trim()
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

  // "Remove" keeps message history and only revokes future auto-connect/trust — see
  // `remove_chat_contact_at`'s own doc comment. "Delete everything" (below) additionally wipes the
  // Direct conversation itself, for someone who explicitly wants that instead.
  const removeContact = async (contact: SyncChatContact) => {
    if (!window.confirm(t('chat.contacts.removeConfirm'))) return
    try {
      await syncRemoveChatContact(contact.accountRoute)
      clearSelectionIfCurrent(contact.accountRoute)
      reloadContacts()
    } catch {
      setContactsError(true)
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
  // ChatPanel's own listener and silently steal/discard whichever event wasn't its own kind) — an
  // automatic mutual-pairing signal from someone who just verified and saved our exported invite
  // code on their own device. Decrypting it (if its token is still valid) both adds them as a
  // contact here and reloads the list, so a chat contact really is a two-way, single confirmation
  // exchange instead of two separate code pastes.
  useEffect(() => {
    let active = true
    const unsubscribe = subscribeToRendezvousEvents((events) => {
      const ackEvents = events.filter((event) => event.envelopeKind === 'chat_contact_ack')
      if (ackEvents.length === 0) return
      console.info('[chat-contact] chat_contact_ack envelopes received', ackEvents.length)
      void (async () => {
        let added = false
        for (const event of ackEvents) {
          if (event.eventType !== 'delivery' || !event.ciphertext) continue
          try {
            const label = await syncOpenChatContactAck(event.ciphertext)
            if (label) {
              added = true
              console.info('[chat-contact] auto-added contact from ack', label)
            } else {
              console.warn('[chat-contact] ack token did not match any live token (stale/reused?)')
            }
          } catch (cause) {
            // Not addressed to this device — but could also be a real bug, so log instead of hiding.
            console.warn('[chat-contact] ack could not be opened (may be addressed to someone else)', cause)
          }
        }
        if (active && added) reloadContacts()
      })()
    })
    return () => {
      active = false
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span>{t('chat.contacts.title')}</span>
          <button
            type="button"
            className={styles.addButton}
            title={t('chat.contacts.add')}
            onClick={() => setAddingContact(true)}
          >
            <Plus size={13} />
          </button>
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
                    })
                  }
                >
                  <Avatar
                    src={null}
                    initial={getProfileInitial(contact.displayLabel)}
                    className={styles.contactAvatar}
                  />
                  <span className={styles.conversationName}>{contact.displayLabel}</span>
                </button>
                <button
                  type="button"
                  className={styles.removeContactButton}
                  title={t('chat.contacts.rename')}
                  onClick={() => void renameContact(contact)}
                >
                  <Pencil size={11} />
                </button>
                <button
                  type="button"
                  className={styles.removeContactButton}
                  title={t('chat.contacts.remove')}
                  onClick={() => void removeContact(contact)}
                >
                  <Trash2 size={12} />
                </button>
                <button
                  type="button"
                  className={styles.removeContactButton}
                  title={t('chat.contacts.deleteAll')}
                  onClick={() => void deleteContactAndHistory(contact)}
                >
                  <Eraser size={12} />
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
    </div>
  )
}

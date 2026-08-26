import { Hash, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { drainRendezvousEvents } from '../../lib/api/syncRendezvous'
import {
  type SyncChatContact,
  syncListChatContacts,
  syncOpenChatContactAck,
  syncRemoveChatContact,
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

  const removeContact = async (contact: SyncChatContact) => {
    if (!window.confirm(t('chat.contacts.removeConfirm'))) return
    try {
      await syncRemoveChatContact(contact.accountRoute)
      if (selected?.kind === 'direct' && selected.contactAccountRoute === contact.accountRoute) {
        setSelected(projectId && projectName ? { kind: 'project', projectId, projectName } : null)
      }
      reloadContacts()
    } catch {
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

  // Drains any `chat_contact_ack` deliveries — an automatic mutual-pairing signal from someone
  // who just verified and saved our exported invite code on their own device. Decrypting it (if
  // its token is still valid) both adds them as a contact here and reloads the list, so a chat
  // contact really is a two-way, single confirmation exchange instead of two separate code pastes.
  useEffect(() => {
    let active = true
    const drain = async () => {
      try {
        const events = await drainRendezvousEvents()
        let added = false
        for (const event of events) {
          if (event.eventType !== 'delivery' || event.envelopeKind !== 'chat_contact_ack') continue
          if (!event.ciphertext) continue
          try {
            const label = await syncOpenChatContactAck(event.ciphertext)
            if (label) added = true
          } catch {
            // Not addressed to this device, or the token no longer matches — ignore.
          }
        }
        if (active && added) reloadContacts()
      } catch {
        // Best-effort — the next tick tries again.
      }
    }
    void drain()
    const timer = window.setInterval(() => void drain(), CONTACT_ACK_POLL_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
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
                  title={t('chat.contacts.remove')}
                  onClick={() => void removeContact(contact)}
                >
                  <Trash2 size={12} />
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

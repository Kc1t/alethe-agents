import { Check, FolderSync, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  grantProjectToInvitee,
  openProjectInvite,
  openProjectInviteResponse,
  type ProjectInvitePayload,
  sealProjectInviteResponse,
} from '../../lib/api/projectInvite'
import { subscribeToRendezvousEvents } from '../../lib/api/rendezvousEventBus'
import { sendRendezvousFrame } from '../../lib/api/syncRendezvous'
import { syncListChatContacts, syncOpenChatContactConfirm } from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { PERMISSION_PRESETS } from '../../lib/sync/permissionPresets'
import styles from './ProjectInvitesPanel.module.css'

const RESPONSE_TTL_MS = 5 * 60 * 1000
/** Access handed out through an invite lasts a working month unless revoked, matching the shortest
 *  choice the pairing flow offers rather than inventing a new duration here. */
const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The receiving half of the project-invite flow.
 *
 * Handles both directions, because both are reactions to an envelope arriving:
 * - an invite for us → shown here with accept/decline;
 * - an answer to an invite we sent → if accepted, issue the grant and ship it back.
 */
export function ProjectInvitesPanel() {
  const t = useT()
  const [invites, setInvites] = useState<ProjectInvitePayload[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = subscribeToRendezvousEvents((events) => {
      void (async () => {
        for (const event of events) {
          if (event.eventType !== 'delivery' || !event.ciphertext) continue

          if (event.envelopeKind === 'project_invite') {
            const invite = await openProjectInvite(event.ciphertext).catch(() => null)
            // `null` means it wasn't addressed to this device, or came from someone who isn't a
            // contact — either way, nothing to show.
            if (invite) {
              setInvites((current) =>
                current.some((entry) => entry.inviteId === invite.inviteId)
                  ? current
                  : [...current, invite],
              )
            }
            continue
          }

          if (event.envelopeKind === 'project_invite_response') {
            const answer = await openProjectInviteResponse(event.ciphertext).catch(() => null)
            if (!answer) continue
            if (!answer.accepted || !answer.accountId || !answer.deviceId) {
              setNotice(t('chat.projectInvite.declined'))
              continue
            }
            // They accepted and sent the identity the grant needs. Issue it and send it back.
            try {
              const sent = pendingProjects.get(answer.inviteId)
              if (!sent) continue
              const confirmCiphertext = await grantProjectToInvitee({
                projectId: sent.projectId,
                accountId: answer.accountId,
                deviceId: answer.deviceId,
                agreementPublicKey: answer.agreementPublicKey ?? '',
                permissions: [...(PERMISSION_PRESETS[0]?.permissions ?? [])],
                pathScopes: [],
                expiresAtMs: Date.now() + GRANT_TTL_MS,
              })
              await sendRendezvousFrame({
                type: 'enqueue',
                kind: 'chat_contact_confirm',
                id: `pinv_grant_${crypto.randomUUID()}`,
                recipientAccountRoute: sent.accountRoute,
                expiresAtMs: Date.now() + RESPONSE_TTL_MS,
                ciphertext: confirmCiphertext,
              })
              pendingProjects.delete(answer.inviteId)
            } catch (cause) {
              console.error('[project-invite] failed to issue grant', cause)
            }
            continue
          }

          if (event.envelopeKind === 'chat_contact_confirm' && awaitingGrant.size > 0) {
            // This is the envelope that carries the grant back after we accepted an invite, and
            // it has to be opened here: the pairing flow's own listener only runs while the "add
            // contact" modal is open and waiting, so outside that modal nothing would materialize
            // the grant and accepting would silently do nothing. Sharing the envelope kind with
            // that listener is safe — the event bus fans every event out to every subscriber
            // precisely so no consumer can steal another's (see rendezvousEventBus.ts).
            const opened = await syncOpenChatContactConfirm(event.ciphertext).catch(() => null)
            if (opened?.grant) {
              const projectName = awaitingGrant.get(opened.grant.projectId)
              awaitingGrant.delete(opened.grant.projectId)
              setNotice(t('chat.projectInvite.accepted', { project: projectName ?? '' }))
            }
          }
        }
      })()
    })
    return unsubscribe
  }, [t])

  const answer = async (invite: ProjectInvitePayload, accepted: boolean) => {
    setBusyId(invite.inviteId)
    try {
      const contacts = await syncListChatContacts()
      const contact = contacts.find((entry) => entry.accountRoute === invite.fromAccountRoute)
      if (!contact) return
      const ciphertext = await sealProjectInviteResponse({
        inviteId: invite.inviteId,
        accepted,
        recipientAgreementPublicKey: contact.agreementPublicKey,
      })
      await sendRendezvousFrame({
        type: 'enqueue',
        kind: 'project_invite_response',
        id: `pinv_res_${crypto.randomUUID()}`,
        recipientAccountRoute: invite.fromAccountRoute,
        expiresAtMs: Date.now() + RESPONSE_TTL_MS,
        ciphertext,
      })
      setInvites((current) => current.filter((entry) => entry.inviteId !== invite.inviteId))
      if (accepted) {
        // The grant arrives in a separate envelope moments later; until it does, nothing has
        // actually been shared yet, so say so rather than claiming the project is already joined.
        awaitingGrant.set(invite.projectId, invite.projectName)
        setNotice(t('chat.projectInvite.awaitingGrant', { project: invite.projectName }))
      } else {
        setNotice(t('chat.projectInvite.declined'))
      }
    } catch (cause) {
      console.error('[project-invite] failed to answer', cause)
    } finally {
      setBusyId(null)
    }
  }

  if (invites.length === 0 && !notice) return null

  return (
    <div className={styles.panel}>
      {invites.map((invite) => (
        <div key={invite.inviteId} className={styles.request}>
          <div className={styles.identity}>
            <FolderSync size={16} />
            <div className={styles.identityText}>
              <strong>{t('chat.projectInvite.incomingTitle')}</strong>
              <span>{invite.projectName}</span>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busyId === invite.inviteId}
              onClick={() => void answer(invite, true)}
            >
              {busyId === invite.inviteId ? <Loader2 size={13} /> : <Check size={13} />}
              {t('chat.projectInvite.accept')}
            </button>
            <button
              type="button"
              disabled={busyId === invite.inviteId}
              onClick={() => void answer(invite, false)}
            >
              <X size={13} />
              {t('chat.projectInvite.decline')}
            </button>
          </div>
        </div>
      ))}
      {notice ? <p className={styles.notice}>{notice}</p> : null}
    </div>
  )
}

/**
 * Which project each invite we sent was for, so the grant can be issued when the answer comes
 * back. Kept in module scope rather than component state because the answer can arrive after the
 * panel has re-mounted, and it is never persisted: an invite whose answer arrives after a restart
 * is simply re-sent, which is safer than writing pending grants to disk.
 */
const pendingProjects = new Map<string, { projectId: string; accountRoute: string }>()

/** Called by the sender when an invite goes out. */
export function rememberSentInvite(inviteId: string, projectId: string, accountRoute: string) {
  pendingProjects.set(inviteId, { projectId, accountRoute })
}

/** Projects this device has accepted an invite for and is waiting the grant envelope for, by
 *  project id — so the confirm that arrives can be recognised as ours and reported by name. */
const awaitingGrant = new Map<string, string>()

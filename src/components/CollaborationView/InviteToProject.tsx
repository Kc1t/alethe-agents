import { FolderSync, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { sealProjectInvite } from '../../lib/api/projectInvite'
import { rememberSentInvite } from './ProjectInvitesPanel'
import { sendRendezvousFrame } from '../../lib/api/syncRendezvous'
import { syncListChatContacts, syncLocalIdentity } from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './ChatPanel.module.css'

/** How long an unanswered invite stays in the relay mailbox before it expires. Long enough for
 *  someone to be offline for a working day, short enough that a forgotten invite doesn't sit
 *  around indefinitely. */
const INVITE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Invites this contact to one of your projects, from inside the conversation.
 *
 * The invite itself carries no access — it names a project and waits. Nothing is granted until the
 * other side accepts, at which point their device sends back the account id needed to issue the
 * grant (see `projectInvite.ts`; the reason for the round trip is ADR-0004).
 */
export function InviteToProject({ contactAccountRoute }: { contactAccountRoute: string }) {
  const t = useT()
  const projects = useProjectsStore((state) => state.projects)
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState(false)

  const send = async () => {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (!project) return
    setBusy(true)
    setFailed(false)
    try {
      const [identity, contacts] = await Promise.all([syncLocalIdentity(), syncListChatContacts()])
      const contact = contacts.find((entry) => entry.accountRoute === contactAccountRoute)
      if (!contact) throw new Error('contact_not_found')
      const inviteId = `pinv_${crypto.randomUUID()}`
      // Recorded before sending: the answer decides which project to grant, and it can
      // come back before this function has finished awaiting the enqueue.
      rememberSentInvite(inviteId, project.id, contactAccountRoute)
      const ciphertext = await sealProjectInvite({
        inviteId,
        projectId: project.id,
        projectName: project.name,
        fromAccountRoute: identity.accountRoute,
        recipientAgreementPublicKey: contact.agreementPublicKey,
        sentAtMs: Date.now(),
      })
      await sendRendezvousFrame({
        type: 'enqueue',
        kind: 'project_invite',
        id: inviteId,
        recipientAccountRoute: contactAccountRoute,
        expiresAtMs: Date.now() + INVITE_TTL_MS,
        ciphertext,
      })
      setSent(true)
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (projects.length === 0) return null

  if (sent) {
    return <span className={styles.contactInfoHint}>{t('chat.projectInvite.sent')}</span>
  }

  if (!open) {
    return (
      <button type="button" className={styles.contactInfoAction} onClick={() => setOpen(true)}>
        <FolderSync size={14} />
        {t('chat.projectInvite.invite')}
      </button>
    )
  }

  return (
    <div className={styles.projectInviteForm}>
      <label className={styles.projectInviteLabel}>{t('chat.projectInvite.chooseProject')}</label>
      <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <span className={styles.contactInfoHint}>{t('chat.projectInvite.explain')}</span>
      <div className={styles.projectInviteActions}>
        <button
          type="button"
          className={styles.contactInfoAction}
          disabled={busy || !projectId}
          onClick={() => void send()}
        >
          {busy ? <Loader2 size={14} className={styles.spin} /> : <FolderSync size={14} />}
          {t('chat.projectInvite.send')}
        </button>
        <button
          type="button"
          className={styles.contactInfoAction}
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          {t('common.cancel')}
        </button>
      </div>
      {failed ? (
        <span className={styles.contactInfoHint}>{t('chat.projectInvite.failed')}</span>
      ) : null}
    </div>
  )
}

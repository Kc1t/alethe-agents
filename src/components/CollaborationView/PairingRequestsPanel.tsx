import { Loader2, UserCheck, UserX, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { sendRendezvousFrame } from '../../lib/api/syncRendezvous'
import {
  type PendingChatContactRequest,
  syncDeclinePendingChatContactRequest,
  syncListPendingChatContactRequests,
  syncResolvePendingChatContactRequest,
} from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { DEFAULT_PROFILE_IMAGE_URL } from '../../lib/profile'
import {
  EXPIRY_CHOICES_MS,
  type ExpiryChoiceId,
  PERMISSION_PRESETS,
  type PermissionPresetId,
} from '../../lib/sync/permissionPresets'
import { getProjectRepoRoot } from '../../lib/terminalFactory'
import { useProjectsStore } from '../../stores/projectsStore'
import { Avatar } from '../ui/Avatar'
import { FolderScopePicker } from './FolderScopePicker'
import styles from './PairingRequestsPanel.module.css'

type Decision = 'chatOnly' | 'withProject'

/**
 * A queue of people who used this device's pairing code and are waiting on a decision — never a
 * single blocking prompt, since several people can ask at once. Each request is reviewed
 * independently: just add them as a chat contact, or also share a specific project with them.
 * Opened from the access-center notification (`AccessKind::PairingRequestPending`) or the badge
 * button in `ChatTab.tsx`.
 */
export function PairingRequestsPanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [requests, setRequests] = useState<PendingChatContactRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)

  const reload = () => {
    setLoading(true)
    syncListPendingChatContactRequests()
      .then((list) => {
        setRequests(list)
        setError(false)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }

  useEffect(reload, [])

  const activeRequest = requests.find((request) => request.requestId === activeRequestId) ?? null

  const onResolved = (requestId: string) => {
    setRequests((current) => current.filter((request) => request.requestId !== requestId))
    setActiveRequestId(null)
  }

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={styles.panel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.title}>{t('pairingRequests.title')}</span>
          <button
            type="button"
            className={styles.closeButton}
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {activeRequest ? (
          <RequestDecision
            request={activeRequest}
            onBack={() => setActiveRequestId(null)}
            onResolved={() => onResolved(activeRequest.requestId)}
          />
        ) : loading ? (
          <div className={styles.loading}>
            <Loader2 size={18} className={styles.spin} />
          </div>
        ) : error ? (
          <span className={styles.error}>{t('pairingRequests.loadFailed')}</span>
        ) : requests.length === 0 ? (
          <div className={styles.empty}>{t('pairingRequests.empty')}</div>
        ) : (
          <div className={styles.list}>
            {requests.map((request) => (
              <button
                key={request.requestId}
                type="button"
                className={styles.listItem}
                onClick={() => setActiveRequestId(request.requestId)}
              >
                <Avatar
                  src={request.avatarThumbnail || DEFAULT_PROFILE_IMAGE_URL}
                  initial={request.displayLabel.slice(0, 2).toUpperCase()}
                  className={styles.listItemAvatar}
                />
                <span className={styles.listItemLabel}>{request.displayLabel}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RequestDecision({
  request,
  onBack,
  onResolved,
}: {
  request: PendingChatContactRequest
  onBack: () => void
  onResolved: () => void
}) {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const [decision, setDecision] = useState<Decision>('chatOnly')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [presetId, setPresetId] = useState<PermissionPresetId>('viewOnly')
  const [expiryId, setExpiryId] = useState<ExpiryChoiceId>('7d')
  const [scopeMode, setScopeMode] = useState<'whole' | 'specific'>('whole')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const project = projects.find((candidate) => candidate.id === projectId)
  // Self-heals a `defaultCwd` left pointing at a dead merge/worktree env folder.
  const projectPath = (project && getProjectRepoRoot(project)) || project?.defaultCwd

  const confirm = async () => {
    setBusy(true)
    setError(false)
    try {
      const grant =
        decision === 'withProject' && project
          ? {
              projectId: project.id,
              permissions: [
                ...(PERMISSION_PRESETS.find((p) => p.id === presetId)?.permissions ?? []),
              ],
              pathScopes:
                scopeMode === 'whole'
                  ? []
                  : Array.from(selectedPaths, (path) => ({
                      effect: 'allow' as const,
                      pattern: `${path}/**`,
                    })),
              expiresAtMs:
                Date.now() +
                (EXPIRY_CHOICES_MS.find((c) => c.id === expiryId)?.ms ?? EXPIRY_CHOICES_MS[0].ms),
            }
          : null
      const resolved = await syncResolvePendingChatContactRequest(request.requestId, grant)
      await sendRendezvousFrame({
        type: 'enqueue',
        kind: 'chat_contact_confirm',
        id: `contact_confirm_${crypto.randomUUID()}`,
        recipientAccountRoute: resolved.accountRoute,
        expiresAtMs: Date.now() + 5 * 60 * 1000,
        ciphertext: resolved.confirmCiphertext,
      })
      onResolved()
    } catch (cause) {
      console.error('[pairing-requests] failed to resolve request', cause)
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const decline = async () => {
    setBusy(true)
    setError(false)
    try {
      await syncDeclinePendingChatContactRequest(request.requestId)
      onResolved()
    } catch (cause) {
      console.error('[pairing-requests] failed to decline request', cause)
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.decision}>
      <div className={styles.decisionHeader}>
        <Avatar
          src={request.avatarThumbnail || DEFAULT_PROFILE_IMAGE_URL}
          initial={request.displayLabel.slice(0, 2).toUpperCase()}
          className={styles.decisionAvatar}
        />
        <span className={styles.decisionLabel}>{request.displayLabel}</span>
      </div>

      <div className={styles.decisionChoices}>
        <button
          type="button"
          className={`${styles.decisionChoice} ${decision === 'chatOnly' ? styles.decisionChoiceActive : ''}`}
          onClick={() => setDecision('chatOnly')}
        >
          {t('pairingRequests.chatOnly')}
        </button>
        <button
          type="button"
          className={`${styles.decisionChoice} ${decision === 'withProject' ? styles.decisionChoiceActive : ''}`}
          disabled={projects.length === 0}
          onClick={() => setDecision('withProject')}
        >
          {t('pairingRequests.withProject')}
        </button>
      </div>

      {decision === 'withProject' ? (
        <div className={styles.grantForm}>
          <label className={styles.label}>{t('pairingRequests.project')}</label>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>

          <label className={styles.label}>{t('mesh.permissionPreset')}</label>
          <select
            value={presetId}
            onChange={(event) => setPresetId(event.target.value as PermissionPresetId)}
          >
            {PERMISSION_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t(`mesh.permissionPreset.${preset.id}`)}
              </option>
            ))}
          </select>

          <label className={styles.label}>{t('mesh.folderScopes')}</label>
          <div className={styles.folderScopeModeRow}>
            <button
              type="button"
              className={`${styles.folderScopeModeBtn} ${scopeMode === 'whole' ? styles.folderScopeModeBtnActive : ''}`}
              onClick={() => setScopeMode('whole')}
            >
              {t('mesh.folderScopesMode.whole')}
            </button>
            <button
              type="button"
              className={`${styles.folderScopeModeBtn} ${scopeMode === 'specific' ? styles.folderScopeModeBtnActive : ''}`}
              onClick={() => setScopeMode('specific')}
            >
              {t('mesh.folderScopesMode.specific')}
            </button>
          </div>
          {scopeMode === 'specific' && projectPath ? (
            <FolderScopePicker
              projectPath={projectPath}
              selectedPaths={selectedPaths}
              onChange={setSelectedPaths}
            />
          ) : null}

          <label className={styles.label}>{t('mesh.invitationExpiry')}</label>
          <select
            value={expiryId}
            onChange={(event) => setExpiryId(event.target.value as ExpiryChoiceId)}
          >
            {EXPIRY_CHOICES_MS.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {t(`mesh.invitationExpiry.${choice.id}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {error ? <span className={styles.error}>{t('pairingRequests.resolveFailed')}</span> : null}

      <div className={styles.decisionActions}>
        <button type="button" className={styles.secondaryButton} onClick={onBack} disabled={busy}>
          {t('common.back')}
        </button>
        <button
          type="button"
          className={styles.declineButton}
          onClick={() => void decline()}
          disabled={busy}
        >
          {busy ? <Loader2 size={13} className={styles.spin} /> : <UserX size={13} />}
          {t('pairingRequests.decline')}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || (decision === 'withProject' && !project)}
          onClick={() => void confirm()}
        >
          {busy ? <Loader2 size={13} className={styles.spin} /> : <UserCheck size={13} />}
          {t('pairingRequests.confirm')}
        </button>
      </div>
    </div>
  )
}

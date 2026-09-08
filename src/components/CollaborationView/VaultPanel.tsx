import {
  Archive,
  ArrowLeft,
  Check,
  Copy,
  Folder,
  FolderCog,
  Loader2,
  RefreshCw,
  UserPlus,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { exportPairingCode, regeneratePairingCode } from '../../lib/api/p2pBridge'
import {
  type SyncGrantRecord,
  type SyncInvitationSummary,
  syncListProjectGrants,
  syncRevokeGrant,
  syncRevokeInvitation,
  syncSecuritySnapshot,
  syncUpdateGrant,
} from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { downscaleAvatar } from '../../lib/image/downscaleAvatar'
import { getProfileInitial } from '../../lib/profile'
import { getProjectRepoRoot } from '../../lib/terminalFactory'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../ui/Avatar'
import { FolderScopePicker } from './FolderScopePicker'
import styles from './VaultPanel.module.css'

/** Reconstructs the folder-picker's `Set<string>` of relative paths from a grant's stored
 * `pathScopes` — patterns are always `${path}/**` (see `MeshSidebarView.tsx::submitInvite`
 * and `sync_security.rs::validate_scopes`), so stripping the suffix round-trips cleanly. */
function pathsFromScopes(pathScopes: SyncGrantRecord['pathScopes']): Set<string> {
  return new Set(
    pathScopes
      .filter((scope) => scope.effect === 'allow')
      .map((scope) => scope.pattern.replace(/\/\*\*$/, '')),
  )
}

// Same three presets already offered when issuing a brand-new invitation (MeshSidebarView.tsx) —
// reused here so editing an existing collaborator's access uses the exact same vocabulary as
// granting it in the first place, instead of a second, differently-worded set of choices.
const PERMISSION_PRESETS = [
  { id: 'viewOnly', permissions: ['read'] as const },
  { id: 'reviewer', permissions: ['read', 'export'] as const },
  { id: 'collaborator', permissions: ['read', 'write'] as const },
] as const

function matchingPresetId(permissions: string[]): (typeof PERMISSION_PRESETS)[number]['id'] | null {
  const sorted = [...permissions].sort().join(',')
  const preset = PERMISSION_PRESETS.find(
    (candidate) => [...candidate.permissions].sort().join(',') === sorted,
  )
  return preset?.id ?? null
}

export function VaultPanel({ projectId, onBack }: { projectId: string; onBack?: () => void }) {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal_)
  const preferences = useProjectsStore((s) => s.preferences)
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  // Self-heals a `defaultCwd` left pointing at a dead merge/worktree env folder.
  const projectPath = (project && getProjectRepoRoot(project)) || project?.defaultCwd
  const [grants, setGrants] = useState<SyncGrantRecord[]>([])
  const [invitations, setInvitations] = useState<SyncInvitationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null)
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null)
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null)
  const [editingPaths, setEditingPaths] = useState<Set<string>>(new Set())
  const [editError, setEditError] = useState(false)

  const [showInviteForm, setShowInviteForm] = useState(false)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false)
  const [pairingCodeBusy, setPairingCodeBusy] = useState(false)
  const [pairingCodeError, setPairingCodeError] = useState(false)

  const loadPairingCode = async () => {
    setPairingCodeBusy(true)
    setPairingCodeError(false)
    try {
      const rawAvatar = preferences.profileImageUrl?.trim() || null
      const thumbnail = rawAvatar ? await downscaleAvatar(rawAvatar) : null
      const code = await exportPairingCode(preferences.displayName || null, thumbnail)
      setPairingCode(code)
    } catch (cause) {
      console.error('[vault] exportPairingCode failed', cause)
      setPairingCodeError(true)
    } finally {
      setPairingCodeBusy(false)
    }
  }

  const regenerateCode = async () => {
    setPairingCodeBusy(true)
    setPairingCodeError(false)
    try {
      const rawAvatar = preferences.profileImageUrl?.trim() || null
      const thumbnail = rawAvatar ? await downscaleAvatar(rawAvatar) : null
      const code = await regeneratePairingCode(preferences.displayName || null, thumbnail)
      setPairingCode(code)
      setPairingCodeCopied(false)
    } catch (cause) {
      console.error('[vault] regeneratePairingCode failed', cause)
      setPairingCodeError(true)
    } finally {
      setPairingCodeBusy(false)
    }
  }

  const copyPairingCode = async () => {
    if (!pairingCode) return
    try {
      await navigator.clipboard.writeText(pairingCode)
      setPairingCodeCopied(true)
      window.setTimeout(() => setPairingCodeCopied(false), 1500)
    } catch {
      setPairingCodeCopied(false)
    }
  }

  useEffect(() => {
    if (showInviteForm && !pairingCode) {
      void loadPairingCode()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInviteForm])

  const reload = () => {
    setLoading(true)
    Promise.all([syncListProjectGrants(projectId), syncSecuritySnapshot()])
      .then(([grantList, snapshot]) => {
        setGrants(grantList)
        setInvitations(
          snapshot.invitations.filter((i) => i.projectId === projectId && i.state === 'created'),
        )
        setError(false)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const applyPreset = async (
    grant: SyncGrantRecord,
    preset: (typeof PERMISSION_PRESETS)[number],
  ) => {
    setBusyGrantId(grant.grantId)
    try {
      await syncUpdateGrant(grant.grantId, [...preset.permissions], grant.pathScopes)
      reload()
    } catch (cause) {
      console.error('[vault] syncUpdateGrant failed', cause)
      setError(true)
    } finally {
      setBusyGrantId(null)
    }
  }

  const startEditFolders = (grant: SyncGrantRecord) => {
    setEditingGrantId(grant.grantId)
    setEditingPaths(pathsFromScopes(grant.pathScopes))
    setEditError(false)
  }

  const saveEditFolders = async (grant: SyncGrantRecord) => {
    setBusyGrantId(grant.grantId)
    try {
      const pathScopes =
        editingPaths.size === 0
          ? []
          : Array.from(editingPaths, (path) => ({
              effect: 'allow' as const,
              pattern: `${path}/**`,
            }))
      await syncUpdateGrant(grant.grantId, grant.permissions, pathScopes)
      setEditingGrantId(null)
      reload()
    } catch (cause) {
      console.error('[vault] syncUpdateGrant (folders) failed', cause)
      setEditError(true)
    } finally {
      setBusyGrantId(null)
    }
  }

  const revoke = async (grant: SyncGrantRecord) => {
    if (!window.confirm(t('vault.revokeConfirm'))) return
    setBusyGrantId(grant.grantId)
    try {
      await syncRevokeGrant(grant.grantId)
      reload()
    } catch (cause) {
      console.error('[vault] syncRevokeGrant failed', cause)
      setError(true)
    } finally {
      setBusyGrantId(null)
    }
  }

  const revokeInvitation = async (invitationId: string) => {
    if (!window.confirm(t('vault.revokeInvitationConfirm'))) return
    setBusyInviteId(invitationId)
    try {
      await syncRevokeInvitation(invitationId)
      reload()
    } catch (cause) {
      console.error('[vault] syncRevokeInvitation failed', cause)
      setError(true)
    } finally {
      setBusyInviteId(null)
    }
  }

  return (
    <div className={styles.container}>
      {onBack ? (
        <button type="button" className={styles.backButton} onClick={onBack}>
          <ArrowLeft size={13} />
          <span>{t('vault.backToProjects')}</span>
        </button>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('vault.collaboratorsTitle')}</span>
          <span className={styles.sectionCount}>{grants.length}</span>
        </div>
        {project ? (
          <p className={styles.projectContext}>{t('vault.forProject', { name: project.name })}</p>
        ) : null}
        <p className={styles.sectionHint}>{t('vault.collaboratorsHint')}</p>
        <p className={styles.p2pNotice}>{t('vault.p2pTransferNotice')}</p>

        <button
          type="button"
          className={styles.inviteToggleButton}
          onClick={() => setShowInviteForm((visible) => !visible)}
        >
          <UserPlus size={13} />
          {t('vault.addCollaborator')}
        </button>

        {showInviteForm ? (
          <div className={styles.inviteForm}>
            <p className={styles.sectionHint}>{t('vault.invitePairingCodeHint')}</p>
            {pairingCodeBusy ? (
              <div className={styles.loading}>
                <Loader2 size={14} className={styles.spin} />
              </div>
            ) : pairingCode ? (
              <>
                <div className={styles.inviteLinkRow}>
                  <code className={styles.inviteLinkCode}>{pairingCode}</code>
                  <button
                    type="button"
                    className={styles.editFoldersButton}
                    onClick={() => void copyPairingCode()}
                    title={t('mesh.copyPairingCode')}
                  >
                    {pairingCodeCopied ? (
                      <Check size={12} className={styles.successIcon} />
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                  <button
                    type="button"
                    className={styles.editFoldersButton}
                    onClick={() => void regenerateCode()}
                    title={t('mesh.generateNewCode')}
                    disabled={pairingCodeBusy}
                  >
                    <RefreshCw size={12} className={pairingCodeBusy ? styles.spin : ''} />
                  </button>
                </div>
                {pairingCodeCopied ? (
                  <span className={styles.successHint}>{t('mesh.pairingCodeCopied')}</span>
                ) : null}
              </>
            ) : pairingCodeError ? (
              <p className={styles.error}>{t('chat.contacts.exportFailed')}</p>
            ) : null}
            <div className={styles.editFoldersActions}>
              <button
                type="button"
                className={styles.editFoldersCancelBtn}
                onClick={() => setShowInviteForm(false)}
              >
                {t('vault.editFoldersCancel')}
              </button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className={styles.loading}>
            <Loader2 size={16} className={styles.spin} />
          </div>
        ) : error ? (
          <p className={styles.error}>{t('vault.loadFailed')}</p>
        ) : grants.length === 0 ? (
          <p className={styles.empty}>{t('vault.noCollaborators')}</p>
        ) : (
          <ul className={styles.grantList}>
            {grants.map((grant) => {
              const activePreset = matchingPresetId(grant.permissions)
              const busy = busyGrantId === grant.grantId
              const isEditingFolders = editingGrantId === grant.grantId
              const scopedPaths = pathsFromScopes(grant.pathScopes)

              return (
                <li key={grant.grantId} className={styles.grantRow}>
                  <div className={styles.grantInfo}>
                    <div className={styles.grantAccountRow}>
                      <Avatar
                        src={null}
                        initial={getProfileInitial(grant.accountId)}
                        className={styles.collaboratorAvatar}
                      />
                      <span className={styles.grantAccount}>{grant.accountId}</span>
                    </div>
                    {scopedPaths.size === 0 ? (
                      <span className={styles.grantScopes}>{t('vault.fullProjectScope')}</span>
                    ) : (
                      <div className={styles.grantScopeChips}>
                        {Array.from(scopedPaths).map((path) => (
                          <span key={path} className={styles.grantScopeChip}>
                            <Folder size={10} />
                            {path}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className={styles.presetGroup}>
                    {PERMISSION_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`${styles.presetButton} ${activePreset === preset.id ? styles.presetButtonActive : ''}`}
                        disabled={busy}
                        onClick={() => void applyPreset(grant, preset)}
                      >
                        {t(`mesh.permissionPreset.${preset.id}`)}
                      </button>
                    ))}
                  </div>
                  {projectPath ? (
                    <button
                      type="button"
                      className={styles.editFoldersButton}
                      disabled={busy}
                      title={t('vault.editFolders')}
                      onClick={() =>
                        isEditingFolders ? setEditingGrantId(null) : startEditFolders(grant)
                      }
                    >
                      <FolderCog size={12} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.revokeButton}
                    disabled={busy}
                    title={t('vault.revoke')}
                    onClick={() => void revoke(grant)}
                  >
                    {busy ? <Loader2 size={12} className={styles.spin} /> : <X size={12} />}
                  </button>
                  {isEditingFolders && projectPath ? (
                    <div className={styles.editFoldersPanel}>
                      <FolderScopePicker
                        projectPath={projectPath}
                        selectedPaths={editingPaths}
                        onChange={setEditingPaths}
                      />
                      {editError ? (
                        <span className={styles.error}>{t('vault.editFoldersFailed')}</span>
                      ) : null}
                      <div className={styles.editFoldersActions}>
                        <button
                          type="button"
                          className={styles.editFoldersCancelBtn}
                          disabled={busy}
                          onClick={() => setEditingGrantId(null)}
                        >
                          {t('vault.editFoldersCancel')}
                        </button>
                        <button
                          type="button"
                          className={styles.editFoldersSaveBtn}
                          disabled={busy}
                          onClick={() => void saveEditFolders(grant)}
                        >
                          {busy ? <Loader2 size={12} className={styles.spin} /> : null}
                          {t('vault.editFoldersSave')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        {invitations.length > 0 ? (
          <div className={styles.pendingSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>{t('vault.pendingInvitations')}</span>
              <span className={styles.sectionCount}>{invitations.length}</span>
            </div>
            <ul className={styles.grantList}>
              {invitations.map((invitation) => {
                const busy = busyInviteId === invitation.invitationId
                return (
                  <li key={invitation.invitationId} className={styles.grantRow}>
                    <div className={styles.grantInfo}>
                      <div className={styles.grantAccountRow}>
                        <Avatar
                          src={null}
                          initial={getProfileInitial(invitation.recipientAccountId)}
                          className={styles.collaboratorAvatar}
                        />
                        <span className={styles.grantAccount}>{invitation.recipientAccountId}</span>
                      </div>
                      <span className={styles.pendingExpiry}>
                        {t('vault.pendingState')} · {t(`mesh.invitationState.${invitation.state}`)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.revokeButton}
                      disabled={busy}
                      title={t('vault.revokeInvitation')}
                      onClick={() => void revokeInvitation(invitation.invitationId)}
                    >
                      {busy ? <Loader2 size={12} className={styles.spin} /> : <X size={12} />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('vault.backupTitle')}</span>
        </div>
        <p className={styles.sectionHint}>{t('vault.backupHint')}</p>
        <button
          type="button"
          className={styles.backupButton}
          onClick={() => openModal('meshFolderTree')}
        >
          <Archive size={14} />
          {t('vault.openBackupVault')}
        </button>
      </section>
    </div>
  )
}

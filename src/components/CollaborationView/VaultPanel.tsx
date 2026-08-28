import { Archive, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  syncListProjectGrants,
  syncRevokeGrant,
  syncUpdateGrant,
  type SyncGrantRecord,
} from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import styles from './VaultPanel.module.css'

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
  const preset = PERMISSION_PRESETS.find((candidate) => [...candidate.permissions].sort().join(',') === sorted)
  return preset?.id ?? null
}

export function VaultPanel({ projectId }: { projectId: string }) {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal_)
  const [grants, setGrants] = useState<SyncGrantRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null)

  const reload = () => {
    setLoading(true)
    syncListProjectGrants(projectId)
      .then((list) => {
        setGrants(list)
        setError(false)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const applyPreset = async (grant: SyncGrantRecord, preset: (typeof PERMISSION_PRESETS)[number]) => {
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

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('vault.collaboratorsTitle')}</span>
          <span className={styles.sectionCount}>{grants.length}</span>
        </div>
        <p className={styles.sectionHint}>{t('vault.collaboratorsHint')}</p>

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
              return (
                <li key={grant.grantId} className={styles.grantRow}>
                  <div className={styles.grantInfo}>
                    <span className={styles.grantAccount}>{grant.accountId}</span>
                    <span className={styles.grantScopes}>
                      {grant.pathScopes.length === 0
                        ? t('vault.fullProjectScope')
                        : grant.pathScopes
                            .map((scope) => `${scope.effect === 'deny' ? '−' : ''}${scope.pattern}`)
                            .join(', ')}
                    </span>
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
                  <button
                    type="button"
                    className={styles.revokeButton}
                    disabled={busy}
                    title={t('vault.revoke')}
                    onClick={() => void revoke(grant)}
                  >
                    {busy ? <Loader2 size={12} className={styles.spin} /> : <X size={12} />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
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

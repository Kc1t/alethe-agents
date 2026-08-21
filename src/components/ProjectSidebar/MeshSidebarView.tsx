import {
  Archive,
  FolderSync,
  Globe,
  Inbox,
  Laptop,
  Loader2,
  Share2,
  ShieldAlert,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { PROJECT_SYNC_CAPABILITIES } from '../../lib/sync/contracts'
import {
  getGoogleSyncStatus,
  type GoogleSyncUser,
  startGoogleSyncAuth,
  type SyncSecuritySnapshot,
  syncSecuritySnapshot,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { EmptyState } from '../EmptyState'
import { GoogleIcon } from '../icons/AgentIcons'
import styles from './MeshSidebarView.module.css'

export function MeshSidebarView() {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]
  const canInvite = PROJECT_SYNC_CAPABILITIES.invitations === 'available'
  const canTransfer = PROJECT_SYNC_CAPABILITIES.projectTransfer === 'available'
  const [security, setSecurity] = useState<SyncSecuritySnapshot | null>(null)
  const [google, setGoogle] = useState<GoogleSyncUser | null>(null)
  const [securityError, setSecurityError] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([syncSecuritySnapshot(), getGoogleSyncStatus()])
      .then(([snapshot, status]) => {
        if (!active) return
        setSecurity(snapshot)
        setGoogle(status)
        setSecurityError(false)
      })
      .catch(() => {
        if (!active) return
        setSecurity(null)
        setSecurityError(true)
      })
    return () => {
      active = false
    }
  }, [])

  const account = security?.account ?? null
  const canAuthenticate = google?.configured === true && !account && !authBusy
  const thisDevice = security?.devices[0] ?? null
  const pendingInvitations = security?.invitations.filter((item) => item.state === 'created') ?? []
  const activeGrants = security?.grants.filter((grant) => !grant.revokedAtMs) ?? []

  const connectGoogle = async () => {
    setAuthBusy(true)
    setAuthError(false)
    try {
      const status = await startGoogleSyncAuth()
      const snapshot = await syncSecuritySnapshot()
      setGoogle(status)
      setSecurity(snapshot)
      setSecurityError(false)
    } catch {
      setAuthError(true)
    } finally {
      setAuthBusy(false)
    }
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <Globe size={15} className={styles.headerIcon} />
          <strong className={styles.title}>{t('mesh.title')}</strong>
        </div>
        <span className={styles.badgeLocal}>{t('mesh.prototype')}</span>
      </header>

      <section className={styles.section}>
        <div className={styles.authCard}>
          <div className={styles.authInfo}>
            <span className={styles.authLabel}>{t('mesh.syncAccount')}</span>
            <span className={styles.authStatus}>
              {securityError
                ? t('mesh.securityLoadFailed')
                : authError
                  ? t('mesh.oauthFailed')
                  : account
                    ? t('mesh.connectedAccount', { name: account.displayName })
                    : google && !google.configured
                      ? t('mesh.oauthNotConfigured')
                      : t('mesh.identityUnavailable')}
            </span>
          </div>
          <button
            type="button"
            className={styles.loginGoogleBtn}
            disabled={!canAuthenticate}
            title={google?.configured ? undefined : t('mesh.oauthNotConfigured')}
            onClick={() => void connectGoogle()}
          >
            {authBusy ? <Loader2 size={14} className={styles.spin} /> : <GoogleIcon size={14} />}
            <span>{authBusy ? t('mesh.authenticating') : t('mesh.connectAccount')}</span>
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.deviceCard}>
          <div className={styles.deviceHeader}>
            <Laptop size={14} />
            <span>{t('mesh.thisDevice')}</span>
          </div>
          <div className={styles.deviceIdRow}>
            {!security && !securityError ? (
              <Loader2 size={13} className={styles.spin} />
            ) : (
              <code className={styles.deviceId}>
                {thisDevice?.deviceId ?? t('mesh.deviceNotRegistered')}
              </code>
            )}
          </div>
          {thisDevice ? (
            <span className={styles.deviceTrust} data-trust={thisDevice.trust}>
              {t(`mesh.deviceTrust.${thisDevice.trust}`)}
            </span>
          ) : null}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.accessCenter')}</span>
        </div>
        <div className={styles.accessGrid}>
          <div className={styles.accessMetric}>
            <Inbox size={14} />
            <span>{t('mesh.pendingInvitations')}</span>
            <strong>{pendingInvitations.length}</strong>
          </div>
          <div className={styles.accessMetric}>
            <Users size={14} />
            <span>{t('mesh.activeGrants')}</span>
            <strong>{activeGrants.length}</strong>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.projectSync')}</span>
        </div>

        {activeProject ? (
          <div className={styles.projectSyncCard}>
            <div className={styles.projectInfo}>
              <FolderSync size={15} className={styles.syncIcon} />
              <div className={styles.projectNames}>
                <strong>{activeProject.name}</strong>
                <span className={styles.projectPath}>{activeProject.defaultCwd}</span>
              </div>
            </div>

            <div className={styles.actionButtons}>
              <button
                type="button"
                className={styles.primaryAction}
                disabled={!canInvite}
                title={t('mesh.unavailableHint')}
              >
                <Share2 size={13} />
                <span>{t('mesh.inviteFriend')}</span>
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                disabled={!canTransfer}
                title={t('mesh.unavailableHint')}
              >
                <Archive size={13} />
                <span>{t('mesh.vault')}</span>
              </button>
            </div>
          </div>
        ) : (
          <EmptyState
            compact
            icon={<FolderSync size={18} />}
            title={t('mesh.noProject')}
            description={t('mesh.noProjectDesc')}
          />
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.security')}</span>
        </div>
        <div className={styles.securityPill}>
          <ShieldAlert size={14} className={styles.shieldIcon} />
          <span>{t('mesh.securityUnavailable')}</span>
        </div>
      </section>
    </div>
  )
}

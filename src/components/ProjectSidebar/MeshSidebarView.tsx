import { Archive, FolderSync, Globe, Laptop, Share2, ShieldAlert } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { EmptyState } from '../EmptyState'
import { GoogleIcon } from '../icons/AgentIcons'
import styles from './MeshSidebarView.module.css'

export function MeshSidebarView() {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]

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
            <span className={styles.authStatus}>{t('mesh.identityUnavailable')}</span>
          </div>
          <button
            type="button"
            className={styles.loginGoogleBtn}
            disabled
            title={t('mesh.unavailableHint')}
          >
            <GoogleIcon size={14} />
            <span>{t('mesh.connectAccount')}</span>
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
            <code className={styles.deviceId}>{t('mesh.deviceNotRegistered')}</code>
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
                disabled
                title={t('mesh.unavailableHint')}
              >
                <Share2 size={13} />
                <span>{t('mesh.inviteFriend')}</span>
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                disabled
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

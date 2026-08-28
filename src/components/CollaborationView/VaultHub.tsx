import { ChevronRight, Folder, Loader2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'

import { syncSecuritySnapshot, type SyncSecuritySnapshot } from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { VaultPanel } from './VaultPanel'
import styles from './VaultHub.module.css'

export function VaultHub() {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [securitySnapshot, setSecuritySnapshot] = useState<SyncSecuritySnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    syncSecuritySnapshot()
      .then((snapshot) => {
        if (active) setSecuritySnapshot(snapshot)
      })
      .catch(() => {
        if (active) setSecuritySnapshot(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [selectedProjectId])

  if (selectedProjectId) {
    return (
      <VaultPanel
        projectId={selectedProjectId}
        onBack={() => setSelectedProjectId(null)}
      />
    )
  }

  const grants = securitySnapshot?.grants ?? []
  const invitations = securitySnapshot?.invitations ?? []

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('vault.hub.title')}</h2>
        <p className={styles.description}>{t('vault.hub.description')}</p>
      </header>

      {loading ? (
        <div className={styles.loading}>
          <Loader2 size={16} className={styles.spin} />
        </div>
      ) : projects.length === 0 ? (
        <div className={styles.loading}>
          <p>{t('vault.hub.noProjects')}</p>
        </div>
      ) : (
        <div className={styles.projectGrid}>
          {projects.map((project) => {
            const activeGrantsCount = grants.filter(
              (g) => g.projectId === project.id && !g.revokedAtMs,
            ).length
            const pendingInvitesCount = invitations.filter(
              (i) => i.projectId === project.id && i.state === 'created',
            ).length

            return (
              <button
                key={project.id}
                type="button"
                className={styles.projectCard}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <div className={styles.projectLeft}>
                  <Folder size={18} className={styles.folderIcon} />
                  <div className={styles.projectInfo}>
                    <span className={styles.projectName}>{project.name}</span>
                    <span className={styles.projectPath}>{project.defaultCwd}</span>
                  </div>
                </div>

                <div className={styles.projectStats}>
                  <span className={styles.statBadge}>
                    <Users size={12} />
                    <span>{t('vault.hub.activeCollaborators', { count: activeGrantsCount })}</span>
                  </span>
                  {pendingInvitesCount > 0 ? (
                    <span className={`${styles.statBadge} ${styles.statBadgePending}`}>
                      <span>{t('vault.hub.pendingInvites', { count: pendingInvitesCount })}</span>
                    </span>
                  ) : null}
                  <ChevronRight size={14} className={styles.chevronIcon} />
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

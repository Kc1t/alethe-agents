import { ArchiveRestore, FolderArchive, History, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { intlLocale, useT } from '../../../lib/i18n'
import {
  killPty,
  listWorkspaceBackups,
  restoreWorkspaceBackup,
  type WorkspaceBackup,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useTerminalsStore } from '../../../stores/terminalsStore'
import { useUiStore } from '../../../stores/uiStore'
import styles from '../PreferencesModal.module.css'

/**
 * The earlier versions of the workspace Alethe keeps beside it, each of which can be put back. The
 * workspace being replaced becomes a backup itself, so a restore can be undone the same way.
 */
function WorkspaceBackups() {
  const t = useT()
  const language = useProjectsStore((state) => state.preferences.language)
  const projects = useProjectsStore((state) => state.projects)
  const hydrate = useProjectsStore((state) => state.hydrate)
  const resetTerminalRuntime = useTerminalsStore((state) => state.reset)
  const pushToast = useUiStore((state) => state.pushToast)
  // null while the list is on its way.
  const [backups, setBackups] = useState<WorkspaceBackup[] | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    let cancelled = false
    listWorkspaceBackups()
      .then((listed) => {
        if (!cancelled) setBackups(listed)
      })
      .catch(() => {
        if (!cancelled) setBackups([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const restore = async (backup: WorkspaceBackup) => {
    if (restoring || !window.confirm(t('prefs.workspaceBackupConfirm'))) return
    setRestoring(true)
    try {
      // The terminals on screen belong to the workspace about to be replaced.
      const ptyIds = projects.flatMap((project) =>
        project.terminals.flatMap((terminal) =>
          terminal.tabs.flatMap((tab) => (tab.ptyId ? [tab.ptyId] : [])),
        ),
      )
      await Promise.allSettled(ptyIds.map((ptyId) => killPty(ptyId)))
      resetTerminalRuntime()
      await restoreWorkspaceBackup(backup.generation)
      await hydrate()
      window.location.reload()
    } catch (error) {
      setRestoring(false)
      pushToast({
        title: t('prefs.workspaceBackupFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const when = new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <>
      <div className={styles.sectionHeading} data-setting-id="workspace-backups" tabIndex={-1}>
        <h2>{t('prefs.workspaceBackupsTitle')}</h2>
        <p>{t('prefs.workspaceBackupsDesc')}</p>
      </div>
      {backups === null ? null : backups.length === 0 ? (
        <div className={styles.emptyState}>{t('prefs.workspaceBackupsEmpty')}</div>
      ) : (
        <div className={styles.optionList}>
          {backups.map((backup) => (
            <div key={backup.generation} className={styles.optionRow}>
              <div className={styles.optionCopy}>
                <strong>{when.format(new Date(backup.modifiedMs))}</strong>
                <span>
                  {t('prefs.workspaceBackupHolds', {
                    projects: backup.projects,
                    terminals: backup.terminals,
                  })}
                </span>
              </div>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={restoring}
                onClick={() => void restore(backup)}
              >
                <History size={14} />
                {t('prefs.workspaceBackupRestore')}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

export function OrganizationPage() {
  const t = useT()
  const allGroups = useProjectsStore((state) => state.groups)
  const unarchiveGroup = useProjectsStore((state) => state.unarchiveGroup)
  const deleteGroup = useProjectsStore((state) => state.deleteGroup)
  const allProjects = useProjectsStore((state) => state.projects)
  const unarchiveProject = useProjectsStore((state) => state.unarchiveProject)
  const groups = useMemo(() => allGroups.filter((group) => group.archived), [allGroups])
  const archivedProjects = useMemo(
    () => allProjects.filter((project) => project.archived),
    [allProjects],
  )

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeading}>
        <h2>{t('prefs.archivedGroupsTitle')}</h2>
        <p>{t('prefs.archivedGroupsDesc')}</p>
      </div>
      {groups.length === 0 ? (
        <div className={styles.emptyState}>{t('prefs.archivedGroupsEmpty')}</div>
      ) : (
        <div className={styles.optionList}>
          {groups.map((group) => (
            <div key={group.id} className={styles.optionRow}>
              <div className={styles.optionCopy}>
                <strong>{group.name}</strong>
                <span>{t('prefs.archivedGroupProjects', { count: group.projectIds.length })}</span>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => unarchiveGroup(group.id)}
                >
                  <ArchiveRestore size={14} />
                  {t('prefs.restoreGroup')}
                </button>
                <button
                  type="button"
                  className={styles.iconActionDanger}
                  title={t('prefs.deleteArchivedGroup')}
                  aria-label={t('prefs.deleteArchivedGroup')}
                  onClick={() => {
                    if (
                      window.confirm(t('prefs.deleteArchivedGroupConfirm', { name: group.name }))
                    ) {
                      deleteGroup(group.id, 'unassign')
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={styles.sectionHeading}>
        <h2>{t('prefs.archivedProjectsTitle')}</h2>
        <p>{t('prefs.archivedProjectsDesc')}</p>
      </div>
      {archivedProjects.length === 0 ? (
        <div className={styles.emptyState}>{t('prefs.archivedProjectsEmpty')}</div>
      ) : (
        <div className={styles.optionList}>
          {archivedProjects.map((project) => (
            <div key={project.id} className={styles.optionRow}>
              <div className={styles.optionCopy}>
                <strong>{project.name}</strong>
                <span>
                  {t('prefs.archivedProjectTerminals', { count: project.terminals.length })}
                </span>
              </div>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => unarchiveProject(project.id)}
              >
                <FolderArchive size={14} />
                {t('prefs.restoreProject')}
              </button>
            </div>
          ))}
        </div>
      )}
      <WorkspaceBackups />
    </section>
  )
}

import { GitBranch } from 'lucide-react'

import { EmptyState } from '../../components/EmptyState'
import { useT } from '../../lib/i18n'
import type { SidebarTabProps } from '../../lib/plugins'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { GitControl } from './GitControl'
import styles from './GitTabs.module.css'

/** Left sidebar: the shell already draws the panel header. */
export function GitLeftTab({ projectId, cwd, ptyId, terminalName }: SidebarTabProps) {
  const t = useT()
  const openModal = useUiStore((state) => state.openModal_)

  if (!projectId || !cwd) {
    return (
      <div className={styles.empty}>
        <EmptyState
          compact
          icon={<GitBranch size={18} />}
          title={t('git.empty.noTerminal')}
          description={t('git.empty.noTerminalDesc')}
          primaryAction={{
            label: t('ui.sidebar.emptyAction'),
            onClick: () => openModal('newProject'),
          }}
        />
      </div>
    )
  }

  return (
    <GitControl
      projectId={projectId}
      cwd={cwd}
      ptyId={ptyId}
      terminalName={terminalName ?? ''}
    />
  )
}

/** Right sidebar: draws its own header, and works without an open terminal. */
export function GitRightTab({ projectId, cwd, ptyId, terminalName }: SidebarTabProps) {
  const t = useT()
  const project = useProjectsStore((state) =>
    projectId ? state.projects.find((candidate) => candidate.id === projectId) : undefined,
  )
  // Source Control follows the SELECTED project rather than requiring an open
  // terminal, so a project with no terminal still reports its git status.
  const resolvedCwd = cwd || project?.defaultCwd
  const resolvedName = terminalName || project?.name || ''

  return (
    <>
      <header className={styles.panelHeader}>
        <GitBranch size={15} />
        <span>{t('ui.sidebar.sourceControl')}</span>
      </header>
      {project && resolvedCwd ? (
        <GitControl
          projectId={project.id}
          cwd={resolvedCwd}
          ptyId={ptyId}
          terminalName={resolvedName}
        />
      ) : (
        <div className={styles.empty}>
          <EmptyState
            compact
            icon={<GitBranch size={18} />}
            title={t('git.empty.noTerminal')}
            description={t('git.empty.noTerminalDesc')}
          />
        </div>
      )}
    </>
  )
}

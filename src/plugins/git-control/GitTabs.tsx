import { GitBranch } from 'lucide-react'

import { EmptyState } from '../../components/EmptyState'
import { useT } from '../../lib/i18n'
import type { SidebarTabProps } from '../../lib/plugins'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { GitControl } from './GitControl'
import styles from './GitTabs.module.css'

/** The shell draws the panel header; this renders the panel body only. */
export function GitTab({ projectId, cwd, ptyId, terminalName }: SidebarTabProps) {
  const t = useT()
  const openModal = useUiStore((state) => state.openModal_)
  const project = useProjectsStore((state) =>
    projectId ? state.projects.find((candidate) => candidate.id === projectId) : undefined,
  )

  // Source Control follows the selected project rather than requiring an open
  // terminal, so a project with no terminal still reports its git status.
  const resolvedCwd = cwd || project?.defaultCwd
  const resolvedName = terminalName || project?.name || ''

  if (!project || !resolvedCwd) {
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
      projectId={project.id}
      cwd={resolvedCwd}
      ptyId={ptyId}
      terminalName={resolvedName}
    />
  )
}

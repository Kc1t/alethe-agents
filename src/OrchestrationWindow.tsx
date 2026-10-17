import { useEffect } from 'react'

import { InAppNotifications } from './components/InAppNotifications'
import { OrchestratorPane } from './components/OrchestratorPane'
import { useReadOnlyProjectsHydration } from './hooks/useReadOnlyProjectsHydration'
import { useAgentCanvasMirror } from './lib/agentCanvasMirror'
import { useT } from './lib/i18n'
import { useAppliedTheme } from './lib/themes'
import styles from './OrchestrationWindow.module.css'
import { useProjectsStore } from './stores/projectsStore'

/**
 * A detached orchestration board (#247): one orchestration pane's board, alone in its own window.
 * It reads the state the main window saves and never writes it (see `setProjectsReadOnly`).
 */
export function OrchestrationWindow({ terminalId }: { terminalId: string }) {
  const t = useT()
  const hydrated = useProjectsStore((s) => s.hydrated)
  const projectId = useProjectsStore(
    (s) =>
      s.projects.find((project) => project.terminals.some((entry) => entry.id === terminalId))
        ?.id ?? null,
  )
  const terminal = useProjectsStore(
    (s) =>
      s.projects
        .find((project) => project.id === projectId)
        ?.terminals.find((entry) => entry.id === terminalId) ?? null,
  )
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const appliedTheme = useAppliedTheme(uiTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle ?? 'normal')

  // The main window owns the subagent canvas; this one shows what it publishes.
  useAgentCanvasMirror()

  useReadOnlyProjectsHydration()

  useEffect(() => {
    if (!hydrated) return
    document.documentElement.dataset.theme = appliedTheme
    document.documentElement.dataset.visualStyle = visualStyle
  }, [appliedTheme, hydrated, visualStyle])

  if (!hydrated) return null
  return (
    <div className={styles.root}>
      {projectId && terminal ? (
        <OrchestratorPane projectId={projectId} terminal={terminal} detached />
      ) : (
        <p className={styles.gone}>{t('orchestrator.windowPaneGone')}</p>
      )}
      <InAppNotifications />
    </div>
  )
}

import { useEffect, useMemo } from 'react'

import { useT } from '../../lib/i18n'
import { useAppliedTheme } from '../../lib/themes'
import { useProjectsStore } from '../../stores/projectsStore'
import { PaneArea } from '../WorkspaceView/PaneArea'
import styles from './DetachedPaneWindow.module.css'

export type DetachedPaneWindowProps = {
  paneId: string
}

/**
 * Root rendered instead of `<App />` in a window opened by `openDetachedPaneWindow`. It hydrates
 * the same `projects.json` the main window uses, locates the one pane it was opened for, and
 * renders just that pane full-window — no sidebars, no other panes, no modals.
 */
export function DetachedPaneWindow({ paneId }: DetachedPaneWindowProps) {
  const t = useT()
  const hydrated = useProjectsStore((s) => s.hydrated)
  const hydrate = useProjectsStore((s) => s.hydrate)
  const projects = useProjectsStore((s) => s.projects)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle ?? 'normal')
  const appliedTheme = useAppliedTheme(uiTheme)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    if (!hydrated) return
    document.documentElement.dataset.theme = appliedTheme
    document.documentElement.dataset.visualStyle = visualStyle
  }, [appliedTheme, hydrated, visualStyle])

  const match = useMemo(() => {
    for (const project of projects) {
      const terminal = project.terminals.find((candidate) => candidate.id === paneId)
      if (terminal) return { project, terminal }
    }
    return null
  }, [projects, paneId])

  useEffect(() => {
    if (match) document.title = match.terminal.name || t('ws.detachedWindowTitle')
  }, [match, t])

  if (!hydrated) {
    return <div className={styles.status}>{t('ws.detachedWindowLoading')}</div>
  }

  if (!match) {
    return <div className={styles.status}>{t('ws.detachedWindowGone')}</div>
  }

  return (
    <div className={styles.root}>
      <PaneArea
        projectId={match.project.id}
        idPrefix={`detached-${paneId}`}
        terminals={[match.terminal]}
        layoutMode="auto"
      />
    </div>
  )
}

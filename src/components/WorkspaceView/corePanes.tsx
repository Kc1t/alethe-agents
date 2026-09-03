import { lazy } from 'react'

import type { MessageKey } from '../../lib/i18n'
import { useT } from '../../lib/i18n'
import type { PaneProps } from '../../lib/plugins'
import { paneContributions } from '../../lib/plugins'
import { DiffPane } from '../DiffPane'
import { ImagePane } from '../ImagePane'
import { OrchestratorPane } from '../OrchestratorPane'
import { TerminalPane } from '../TerminalPane'
import { VideoPane } from '../VideoPane'
import { WebPane } from '../WebPane'
import styles from './WorkspaceView.module.css'

const GraphifyView = lazy(() =>
  import('../GraphifyView').then((m) => ({ default: m.GraphifyView })),
)
const MarkdownPane = lazy(() => import('../MarkdownPane').then((m) => ({ default: m.MarkdownPane })))

function PaneLoading({ messageKey }: { messageKey: MessageKey }) {
  const t = useT()
  return <div className={styles.paneLoading}>{t(messageKey)}</div>
}

function GraphifyPane({ projectId, terminal }: PaneProps) {
  return <GraphifyView repo={terminal.cwd} projectId={projectId} terminalId={terminal.id} />
}

/** The default pane, used for any kind with no contribution of its own. */
export const TERMINAL_PANE_ID = 'terminal'

/**
 * Core panes go through the same registry as plugin panes, so there is a single
 * lookup path and a plugin cannot silently shadow a built-in kind.
 */
export function registerCorePanes(): void {
  if (paneContributions.has(TERMINAL_PANE_ID)) return

  paneContributions.add('core', { id: TERMINAL_PANE_ID, component: TerminalPane })
  paneContributions.add('core', {
    id: 'graphify',
    component: GraphifyPane,
    fallback: <PaneLoading messageKey="ws.paneLoadingGraph" />,
  })
  paneContributions.add('core', {
    id: 'markdown',
    component: MarkdownPane,
    fallback: <PaneLoading messageKey="ws.paneLoadingMarkdown" />,
  })
  paneContributions.add('core', {
    id: 'file',
    component: MarkdownPane,
    fallback: <PaneLoading messageKey="ws.paneLoadingMarkdown" />,
  })
  paneContributions.add('core', { id: 'web', component: WebPane })
  paneContributions.add('core', { id: 'video', component: VideoPane })
  paneContributions.add('core', { id: 'image', component: ImagePane })
  paneContributions.add('core', { id: 'diff', component: DiffPane })
  paneContributions.add('core', { id: 'orchestrator', component: OrchestratorPane })
}

import { Plug, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { groupServersByName, matchesQuery } from '../../lib/mcp'
import type { McpAgentSnapshot, McpScope } from '../../lib/types'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import { useMcpStore } from '../../stores/mcpStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { ScopeSwitch } from './ScopeSwitch'
import { ServerRow } from './ServerRow'
import styles from './McpPanel.module.css'

type Diagnostic = {
  agent: McpAgentSnapshot['agent']
  detail: string
}

export function McpPanel() {
  const t = useT()
  const scope = useMcpStore((state) => state.scope)
  const snapshots = useMcpStore((state) => state.snapshots)
  const loading = useMcpStore((state) => state.loading)
  const error = useMcpStore((state) => state.error)
  const refresh = useMcpStore((state) => state.refresh)

  const defaultScope = useProjectsStore((state) => state.preferences.mcpDefaultScope)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const projects = useProjectsStore((state) => state.projects)
  const openModal = useUiStore((state) => state.openModal_)

  const repo = useMemo(() => {
    const project = projects.find((item) => item.id === activeProjectId) ?? projects[0]
    if (!project) return null
    const fromProject = project.defaultCwd?.trim()
    if (fromProject) return fromProject
    return project.terminals.find((terminal) => terminal.cwd)?.cwd ?? null
  }, [projects, activeProjectId])

  const bootScopeRef = useRef<McpScope>(defaultScope)
  const initialisedRef = useRef(false)
  const [term, setTerm] = useState('')

  useEffect(() => {
    if (!initialisedRef.current) {
      initialisedRef.current = true
      void refresh({ scope: bootScopeRef.current, repo })
      return
    }
    void refresh({ repo })
  }, [refresh, repo])

  const groups = useMemo(() => groupServersByName(snapshots), [snapshots])
  const visible = useMemo(
    () => groups.filter((group) => matchesQuery(group, term)),
    [groups, term],
  )

  const readableAgents = snapshots.filter(
    (snapshot) => snapshot.exists && snapshot.parseError === null,
  ).length

  const diagnostics: Diagnostic[] = snapshots
    .map((snapshot) => {
      if (snapshot.sourcePath === null) {
        return { agent: snapshot.agent, detail: t('mcp.diagUnsupported') }
      }
      if (snapshot.parseError) {
        return { agent: snapshot.agent, detail: t('mcp.diagUnreadable') }
      }
      if (!snapshot.exists) {
        return { agent: snapshot.agent, detail: t('mcp.diagMissing') }
      }
      if (!snapshot.writable) {
        return { agent: snapshot.agent, detail: t('mcp.diagReadOnly') }
      }
      return null
    })
    .filter((entry): entry is Diagnostic => entry !== null)

  const openManager = (server: string) => openModal('mcpManager', { server })

  const changeScope = (next: McpScope) => {
    if (next === scope) return
    setPreferences({ mcpDefaultScope: next })
    void refresh({ scope: next, repo })
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <ScopeSwitch value={scope} projectAvailable={repo !== null} onChange={changeScope} />
        <button
          type="button"
          className={styles.headerAction}
          onClick={() => void refresh()}
          disabled={loading}
          title={t('mcp.refresh')}
          aria-label={t('mcp.refresh')}
        >
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        </button>
      </div>

      <div className={styles.search}>
        <Search size={13} />
        <input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('mcp.search')}
          aria-label={t('mcp.search')}
        />
      </div>

      <div className={styles.stats}>
        <span>
          <b>{groups.length}</b> {t('mcp.statServers')}
        </span>
        <span>
          <b>{readableAgents}</b> {t('mcp.statAgents')}
        </span>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {visible.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            compact
            icon={<Plug size={20} />}
            title={groups.length === 0 ? t('mcp.emptyTitle') : t('mcp.noMatch')}
            description={groups.length === 0 ? t('mcp.emptyDescription') : undefined}
          />
        </div>
      ) : (
        <div className={styles.list}>
          {visible.map((group) => (
            <ServerRow key={group.name} group={group} onOpen={openManager} />
          ))}
        </div>
      )}

      {diagnostics.length > 0 ? (
        <div className={styles.diagnostics}>
          <span className={styles.diagnosticsTitle}>{t('mcp.diagTitle')}</span>
          {diagnostics.map((entry) => (
            <span key={entry.agent} className={styles.diagnostic}>
              <span className={styles.diagnosticAgent}>{AGENT_TYPE_LABELS[entry.agent]}</span>
              <span>{entry.detail}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

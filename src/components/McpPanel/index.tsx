import { Link2, Lock, Plug, Plus, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { groupServersByName, matchesQuery, mcpErrorKey } from '../../lib/mcp'
import { groupSkillsByName, matchesSkillQuery } from '../../lib/skills'
import { skillsScan, type SkillAgentSnapshot } from '../../lib/tauri'
import type { AgentType, McpAgent, McpAgentSnapshot, McpScope } from '../../lib/types'
import { AGENT_TYPE_LABELS, MCP_AGENTS } from '../../lib/types'
import { useMcpStore } from '../../stores/mcpStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { AgentIcon } from '../icons/AgentIcons'
import controls from '../modals/controls.module.css'
import { ScopeSwitch } from './ScopeSwitch'
import { ServerRow } from './ServerRow'
import styles from './McpPanel.module.css'

type View = 'servers' | 'skills'

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
  const theme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
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
  const [view, setView] = useState<View>('servers')
  const [term, setTerm] = useState('')
  const [agentFilter, setAgentFilter] = useState<McpAgent[]>([])
  const [skills, setSkills] = useState<SkillAgentSnapshot[] | null>(null)

  useEffect(() => {
    if (!initialisedRef.current) {
      initialisedRef.current = true
      void refresh({ scope: bootScopeRef.current, repo })
      return
    }
    void refresh({ repo })
  }, [refresh, repo])

  // Skills live outside the MCP scan and are only worth reading once the tab is opened.
  useEffect(() => {
    if (view !== 'skills' || skills !== null) return
    void skillsScan()
      .then(setSkills)
      .catch(() => setSkills([]))
  }, [view, skills])

  const keepsAgent = (agents: string[]) =>
    agentFilter.length === 0 || agentFilter.some((agent) => agents.includes(agent))

  const groups = useMemo(() => groupServersByName(snapshots), [snapshots])
  const visibleServers = useMemo(
    () => groups.filter((group) => matchesQuery(group, term) && keepsAgent(group.agents)),
    [groups, term, agentFilter],
  )
  const skillGroups = useMemo(() => groupSkillsByName(skills ?? []), [skills])
  const visibleSkills = useMemo(
    () => skillGroups.filter((group) => matchesSkillQuery(group, term) && keepsAgent(group.agents)),
    [skillGroups, term, agentFilter],
  )

  const diagnostics: Diagnostic[] = snapshots
    .map((snapshot) => {
      if (snapshot.sources.length === 0) {
        return { agent: snapshot.agent, detail: t('mcp.diagUnsupported') }
      }
      if (snapshot.sources.some((source) => source.parseError !== null)) {
        return { agent: snapshot.agent, detail: t('mcp.diagUnreadable') }
      }
      if (snapshot.sources.every((source) => !source.exists)) {
        return { agent: snapshot.agent, detail: t('mcp.diagMissing') }
      }
      if (snapshot.sources.some((source) => source.exists && !source.writable)) {
        return { agent: snapshot.agent, detail: t('mcp.diagReadOnly') }
      }
      return null
    })
    .filter((entry): entry is Diagnostic => entry !== null)

  const changeScope = (next: McpScope) => {
    if (next === scope) return
    setPreferences({ mcpDefaultScope: next })
    void refresh({ scope: next, repo })
  }

  const toggleAgent = (agent: McpAgent) =>
    setAgentFilter((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    )

  const showingServers = view === 'servers'
  const visibleCount = showingServers ? visibleServers.length : visibleSkills.length
  const total = showingServers ? groups.length : skillGroups.length

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.segmented} role="group" aria-label={t('mcp.viewLabel')}>
          {(['servers', 'skills'] as View[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
            >
              {t(option === 'servers' ? 'mcp.tabServers' : 'mcp.tabSkills')}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={controls.iconBtnSm}
          onClick={() => (showingServers ? void refresh() : setSkills(null))}
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
          placeholder={showingServers ? t('mcp.search') : t('mcp.searchSkills')}
          aria-label={showingServers ? t('mcp.search') : t('mcp.searchSkills')}
        />
      </div>

      <div className={styles.filters}>
        <span className={styles.agentFilter} role="group" aria-label={t('mcp.filterByAgent')}>
          {MCP_AGENTS.map((agent) => {
            const on = agentFilter.includes(agent)
            return (
              <button
                key={agent}
                type="button"
                aria-pressed={on}
                className={on ? styles.agentChipOn : styles.agentChip}
                onClick={() => toggleAgent(agent)}
                title={AGENT_TYPE_LABELS[agent]}
                aria-label={AGENT_TYPE_LABELS[agent]}
              >
                <AgentIcon type={agent} size={13} theme={theme} />
              </button>
            )
          })}
        </span>
        {showingServers ? (
          <ScopeSwitch value={scope} projectAvailable={repo !== null} onChange={changeScope} />
        ) : null}
      </div>

      <div className={styles.stats}>
        <span>
          <b>{visibleCount}</b> {showingServers ? t('mcp.statServers') : t('mcp.statSkills')}
          {agentFilter.length > 0 || term.trim() ? ` ${t('mcp.ofTotal', { total })}` : ''}
        </span>
      </div>

      {error && showingServers ? <div className={styles.error}>{t(mcpErrorKey(error))}</div> : null}

      {visibleCount === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            compact
            icon={<Plug size={20} />}
            title={
              total === 0
                ? showingServers
                  ? t('mcp.emptyTitle')
                  : t('skills.emptyTitle')
                : t('mcp.noMatch')
            }
            description={total === 0 && showingServers ? t('mcp.emptyDescription') : undefined}
          />
        </div>
      ) : (
        <div className={styles.list}>
          {showingServers
            ? visibleServers.map((group) => (
                <ServerRow
                  key={group.name}
                  group={group}
                  theme={theme}
                  onOpen={(server) => openModal('mcpManager', { tab: 'servers', server })}
                />
              ))
            : visibleSkills.map((group) => (
                <button
                  key={group.name}
                  type="button"
                  className={styles.row}
                  onClick={() => openModal('mcpManager', { tab: 'skills' })}
                >
                  <span className={styles.rowTop}>
                    <span className={styles.name}>{group.name}</span>
                    {group.bundled ? <Lock size={11} /> : null}
                    {group.sharedEntry ? <Link2 size={11} /> : null}
                    <span className={styles.agentIcons} title={group.agents.join(', ')}>
                      {group.agents.map((agent) => (
                        <i key={agent} className={styles.agentOn}>
                          <AgentIcon type={agent as AgentType} size={13} theme={theme} />
                        </i>
                      ))}
                    </span>
                  </span>
                  <span className={styles.summary}>
                    {group.description ||
                      group.agents
                        .map((agent) => AGENT_TYPE_LABELS[agent as AgentType] ?? agent)
                        .join(', ')}
                  </span>
                </button>
              ))}
        </div>
      )}

      <button
        type="button"
        className={styles.addMore}
        onClick={() =>
          openModal(
            'mcpManager',
            showingServers ? { tab: 'servers', add: true } : { tab: 'skills' },
          )
        }
      >
        <Plus size={13} />
        {showingServers ? t('mcp.addMore') : t('skills.manage')}
      </button>

      {showingServers && diagnostics.length > 0 ? (
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

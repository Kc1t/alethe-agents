import { Check, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { isOutdated } from '../../../lib/agentVersions'
import type { AgentType, Theme } from '../../../lib/types'
import { AgentInstallButton } from '../../AgentInstall/AgentInstallButton'
import { AgentUninstallButton } from '../../AgentInstall/AgentUninstallButton'
import { AgentUpdateButton } from '../../AgentInstall/AgentUpdateButton'
import { AgentIcon } from '../../icons/AgentIcons'
import styles from './AgentsStep.module.css'

export type AgentRow = {
  id: Exclude<AgentType, 'shell'>
  label: string
}

type Filter = 'all' | 'detected' | 'installable'

type Props = {
  agents: AgentRow[]
  availability: Partial<Record<string, boolean>>
  versions: Partial<Record<string, string>>
  latest: Partial<Record<string, string>>
  paths: Partial<Record<string, string>>
  enabled: Partial<Record<string, boolean>>
  detecting: boolean
  terminalTheme: Theme
  onToggle: (agent: AgentRow['id'], value: boolean) => void
  onRescan: () => void
  onInstalled: (agent: AgentRow['id']) => void
  onUninstalled: (agent: AgentRow['id']) => void
}

export function AgentsStep({
  agents,
  availability,
  versions,
  latest,
  paths,
  enabled,
  detecting,
  terminalTheme,
  onToggle,
  onRescan,
  onInstalled,
  onUninstalled,
}: Props) {
  const t = useT()
  const [term, setTerm] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const rows = useMemo(
    () =>
      agents.map((agent) => {
        const installed = availability[agent.id] ?? false
        const version = versions[agent.id]
        const newest = latest[agent.id]
        return {
          agent,
          installed,
          version,
          latest: newest,
          path: paths[agent.id],
          outdated: Boolean(version && newest && isOutdated(version, newest)),
        }
      }),
    [agents, availability, versions, latest, paths],
  )

  const stats = useMemo(
    () => ({
      active: rows.filter((row) => enabled[row.agent.id]).length,
      upToDate: rows.filter((row) => row.installed && row.version && !row.outdated).length,
      outdated: rows.filter((row) => row.outdated).length,
      installable: rows.filter((row) => !row.installed).length,
    }),
    [rows, enabled],
  )

  const needle = term.trim().toLowerCase()
  const visible = rows.filter((row) => {
    if (filter === 'detected' && !row.installed) return false
    if (filter === 'installable' && row.installed) return false
    if (!needle) return true
    return `${row.agent.label} ${row.agent.id} ${row.path ?? ''}`.toLowerCase().includes(needle)
  })

  return (
    <div className={styles.step}>
      <div className={styles.intro}>
        <h2 className={styles.title}>{t('onboarding.agentsTitle')}</h2>
        <p className={styles.subtitle}>{t('onboarding.agentsSubtitle')}</p>
      </div>

      <div className={styles.stats}>
        <span className={styles.stat}>
          <i className={styles.dotAccent} />
          <b>{stats.active}</b> {t('onboarding.agentsStatActive')}
        </span>
        <span className={styles.stat}>
          <i className={styles.dotOk} />
          <b>{stats.upToDate}</b> {t('onboarding.agentsStatUpToDate')}
        </span>
        <span className={styles.stat}>
          <i className={styles.dotWarn} />
          <b>{stats.outdated}</b> {t('onboarding.agentsStatOutdated')}
        </span>
        <span className={styles.stat}>
          <i className={styles.dot} />
          <b>{stats.installable}</b> {t('onboarding.agentsStatInstallable')}
        </span>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.field}>
          <Search size={14} />
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t('onboarding.agentsSearch')}
            aria-label={t('onboarding.agentsSearch')}
          />
        </div>
        <div className={styles.segmented} role="group">
          {(['all', 'detected', 'installable'] as Filter[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {t(`onboarding.agentsFilter.${option}`)}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label={t('onboarding.agentsTitle')}>
          <colgroup>
            <col className={styles.colCheck} />
            <col />
            <col className={styles.colVersion} />
            <col className={styles.colStatus} />
            <col className={styles.colActions} />
          </colgroup>
          <tbody>
            {visible.map((row) => {
              const active = Boolean(enabled[row.agent.id])
              const selectable = !detecting && row.installed
              return (
                <tr
                  key={row.agent.id}
                  className={row.installed ? '' : styles.rowOff}
                  data-on={active ? '1' : '0'}
                  onClick={() => {
                    if (selectable) onToggle(row.agent.id, !active)
                  }}
                >
                  <td>
                    {row.installed ? (
                      <span
                        className={`${styles.check} ${active ? styles.checkOn : ''}`}
                        role="checkbox"
                        aria-checked={active}
                        aria-label={row.agent.label}
                        tabIndex={selectable ? 0 : -1}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          if (selectable) onToggle(row.agent.id, !active)
                        }}
                      >
                        {active ? <Check size={11} /> : null}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <div className={styles.agent}>
                      <span className={styles.icon}>
                        <AgentIcon type={row.agent.id} size={22} theme={terminalTheme} />
                      </span>
                      <span className={styles.meta}>
                        <b>{row.agent.label}</b>
                        <span title={row.path}>
                          {row.path ?? t('onboarding.agentNotFoundPath')}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className={styles.version}>{row.version ? `v${row.version}` : '—'}</td>
                  <td>
                    {detecting ? (
                      <span className={`${styles.tag} ${styles.tagIdle}`}>
                        <i />
                        {t('onboarding.agentChecking')}
                      </span>
                    ) : !row.installed ? (
                      <span className={`${styles.tag} ${styles.tagIdle}`}>
                        <i />
                        {t('onboarding.agentNotInstalled')}
                      </span>
                    ) : row.outdated ? (
                      <span className={`${styles.tag} ${styles.tagWarn}`}>
                        <i />
                        {t('onboarding.agentUpdate', { version: row.latest ?? '' })}
                      </span>
                    ) : row.version && row.latest ? (
                      <span className={`${styles.tag} ${styles.tagOk}`}>
                        <i />
                        {t('onboarding.agentUpToDate')}
                      </span>
                    ) : (
                      <span className={`${styles.tag} ${styles.tagIdle}`}>
                        <i />
                        {t('onboarding.agentUnknownVersion')}
                      </span>
                    )}
                  </td>
                  <td
                    className={styles.actions}
                    onClick={(event) => event.stopPropagation()}
                    role="presentation"
                  >
                    {detecting ? null : row.installed ? (
                      <div className={styles.actionStack}>
                        {row.outdated ? (
                          <AgentUpdateButton
                            agent={row.agent.id}
                            label={row.agent.label}
                            onUpdated={() => onInstalled(row.agent.id)}
                          />
                        ) : null}
                        <AgentUninstallButton
                          nested
                          agent={row.agent.id}
                          label={row.agent.label}
                          onUninstalled={() => onUninstalled(row.agent.id)}
                        />
                      </div>
                    ) : (
                      <AgentInstallButton
                        nested
                        agent={row.agent.id}
                        label={row.agent.label}
                        onInstalled={() => onInstalled(row.agent.id)}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <div className={styles.empty}>{t('onboarding.agentsNoMatch')}</div>
        ) : null}
      </div>

      <div className={styles.note}>
        {t('onboarding.agentsMissing')}
        <button type="button" onClick={onRescan} disabled={detecting}>
          {detecting ? t('onboarding.agentsDetecting') : t('onboarding.agentsRescan')}
        </button>
      </div>
    </div>
  )
}

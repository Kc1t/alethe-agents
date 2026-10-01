import { Check } from 'lucide-react'
import { useMemo } from 'react'

import { isOutdated } from '../../../lib/agentVersions'
import { useT } from '../../../lib/i18n'
import type { AgentType, Theme } from '../../../lib/types'
import { AgentInstallButton } from '../../AgentInstall/AgentInstallButton'
import { AgentUpdateButton } from '../../AgentInstall/AgentUpdateButton'
import { AgentIcon } from '../../icons/AgentIcons'
import styles from './AgentsStep.module.css'

export type AgentRow = {
  id: Exclude<AgentType, 'shell'>
  label: string
}

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
}: Props) {
  const t = useT()

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

  const detected = rows.filter((row) => row.installed).length
  const active = rows.filter((row) => row.installed && enabled[row.agent.id]).length

  return (
    <div className={styles.step}>
      <div className={styles.intro}>
        <h2 className={styles.title}>{t('onboarding.agentsTitle')}</h2>
        <p className={styles.subtitle}>
          {detecting
            ? t('onboarding.agentsDetecting')
            : t('onboarding.agentsFound', { count: detected })}
        </p>
      </div>

      <div className={styles.grid}>
        {rows.map((row) => {
          const on = row.installed && Boolean(enabled[row.agent.id])
          const selectable = !detecting && row.installed
          return (
            <div
              key={row.agent.id}
              role="checkbox"
              aria-checked={on}
              aria-disabled={!selectable}
              tabIndex={selectable ? 0 : -1}
              className={[styles.card, on ? styles.cardOn : '', row.installed ? '' : styles.cardOff]
                .filter(Boolean)
                .join(' ')}
              title={row.path ?? t('onboarding.agentNotFoundPath')}
              onClick={() => {
                if (selectable) onToggle(row.agent.id, !on)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (selectable) onToggle(row.agent.id, !on)
              }}
            >
              <span className={styles.tick} aria-hidden>
                <Check size={10} />
              </span>
              <span className={styles.logo}>
                <AgentIcon type={row.agent.id} size={26} theme={terminalTheme} />
              </span>
              <span className={styles.name}>{row.agent.label}</span>
              {detecting ? (
                <span className={styles.state}>{t('onboarding.agentChecking')}</span>
              ) : row.installed ? (
                <span className={styles.state}>
                  {row.version ? `v${row.version}` : t('onboarding.agentReady')}
                </span>
              ) : (
                <span className={styles.action} onClick={(event) => event.stopPropagation()}>
                  <AgentInstallButton
                    nested
                    agent={row.agent.id}
                    label={row.agent.label}
                    onInstalled={() => onInstalled(row.agent.id)}
                  />
                </span>
              )}
              {row.outdated ? (
                <span className={styles.action} onClick={(event) => event.stopPropagation()}>
                  <AgentUpdateButton
                    agent={row.agent.id}
                    label={row.agent.label}
                    onUpdated={() => onInstalled(row.agent.id)}
                  />
                </span>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className={styles.footnote}>
        <span className={styles.count}>
          {t('onboarding.agentsEnabledOf', { active, total: rows.length })}
        </span>
        <button type="button" onClick={onRescan} disabled={detecting}>
          {detecting ? t('onboarding.agentsDetecting') : t('onboarding.agentsRescan')}
        </button>
      </div>
    </div>
  )
}

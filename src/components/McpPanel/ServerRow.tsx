import type { McpServerGroup } from '../../lib/mcp'
import { transportSummary } from '../../lib/mcp'
import { useT } from '../../lib/i18n'
import { AGENT_TYPE_LABELS, MCP_AGENTS, type Theme } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import styles from './McpPanel.module.css'

type Props = {
  group: McpServerGroup
  theme: Theme
  onOpen: (name: string) => void
}

export function ServerRow({ group, theme, onOpen }: Props) {
  const t = useT()
  const primary = group.records[0]
  const importedFrom = group.records.find((record) => record.managedByImport)?.managedByImport
  const present = group.agents.map((agent) => AGENT_TYPE_LABELS[agent]).join(', ')
  const missing = group.missingAgents.map((agent) => AGENT_TYPE_LABELS[agent]).join(', ')

  return (
    <button type="button" className={styles.row} onClick={() => onOpen(group.name)}>
      <span className={styles.rowTop}>
        <span className={styles.name}>{group.name}</span>
        {group.hasDisabled ? <span className={styles.badge}>{t('mcp.badgeDisabled')}</span> : null}
        {importedFrom ? (
          <span
            className={`${styles.badge} ${styles.badgeWarn}`}
            title={t('mcp.managedByImportHint', { plugin: importedFrom })}
          >
            {t('mcp.badgeImported')}
          </span>
        ) : null}
        <span
          className={styles.agentIcons}
          title={
            missing
              ? `${t('mcp.presentOn', { agents: present })} · ${t('mcp.missingOn', { agents: missing })}`
              : t('mcp.presentOn', { agents: present })
          }
        >
          {MCP_AGENTS.filter(
            (agent) => group.agents.includes(agent) || group.missingAgents.includes(agent),
          ).map((agent) => (
            <i
              key={agent}
              className={group.agents.includes(agent) ? styles.agentOn : styles.agentOff}
            >
              <AgentIcon type={agent} size={13} theme={theme} />
            </i>
          ))}
        </span>
      </span>
      <span className={styles.summary}>{transportSummary(primary.server.transport)}</span>
    </button>
  )
}

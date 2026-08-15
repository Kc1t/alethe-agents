import type { McpServerGroup } from '../../lib/mcp'
import { transportSummary } from '../../lib/mcp'
import { useT } from '../../lib/i18n'
import { AGENT_TYPE_LABELS, MCP_AGENTS } from '../../lib/types'
import styles from './McpPanel.module.css'

type Props = {
  group: McpServerGroup
  onOpen: (name: string) => void
}

export function ServerRow({ group, onOpen }: Props) {
  const t = useT()
  const primary = group.records[0]
  const importedFrom = group.records.find((record) => record.managedByImport)?.managedByImport
  const presentLabel = group.agents.map((agent) => AGENT_TYPE_LABELS[agent]).join(', ')

  return (
    <button type="button" className={styles.row} onClick={() => onOpen(group.name)}>
      <span className={styles.rowTop}>
        <span className={styles.name}>{group.name}</span>
        {group.hasDisabled ? (
          <span className={styles.badge}>{t('mcp.badgeDisabled')}</span>
        ) : null}
        {importedFrom ? (
          <span className={`${styles.badge} ${styles.badgeWarn}`} title={t('mcp.managedByImportHint', { plugin: importedFrom })}>
            {t('mcp.badgeImported')}
          </span>
        ) : null}
        <span className={styles.dots} title={t('mcp.presentOn', { agents: presentLabel })}>
          {MCP_AGENTS.map((agent) => {
            const on = group.agents.includes(agent)
            return (
              <i
                key={agent}
                className={`${styles.dot} ${on ? styles.dotOn : styles.dotOff}`}
                style={on ? { background: `var(--agent-${agent})` } : undefined}
                aria-hidden
              />
            )
          })}
        </span>
      </span>
      <span className={styles.summary}>{transportSummary(primary.server.transport)}</span>
    </button>
  )
}

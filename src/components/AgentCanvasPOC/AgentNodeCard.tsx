import { Users } from 'lucide-react'
import { type MutableRefObject } from 'react'

import { MINI_FEED_SIZE } from '../../lib/agentCanvasConfig'
import { colorFor, costClassFor, durationLabel, statusBadgeClass } from '../../lib/agentCanvasUtils'
import { fmtTokens, fmtUsd, shortModel } from '../../lib/costFormat'
import { useT } from '../../lib/i18n'
import type { SessionCost } from '../../lib/tauri'
import type { AgentNode } from '../../stores/agentCanvasStore'
import styles from './AgentCanvasPOC.module.css'

type AgentNodeCardProps = {
  node: AgentNode
  cost: SessionCost | undefined
  onSelect: (id: string) => void

  cardRefs: MutableRefObject<Map<string, HTMLDivElement>>
}

/** Node card for a subagent or teammate. */
export function AgentNodeCard({ node, cost, onSelect, cardRefs }: AgentNodeCardProps) {
  const t = useT()
  const model = cost ? shortModel(cost.model) : null
  return (
    <div
      key={node.id}
      ref={(el) => {
        if (el) cardRefs.current.set(node.id, el)
        else cardRefs.current.delete(node.id)
      }}
      className={[
        styles.card,
        node.kind === 'teammate' ? styles.cardTeammate : '',
        node.status === 'done' ? styles.cardDone : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ ['--agent-color' as string]: colorFor(node.agentType) }}
      onClick={() => onSelect(node.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(node.id)
      }}
    >
      <div className={styles.cardHeader}>
        <span className={styles.cardType}>
          {node.kind === 'teammate' ? <Users size={12} /> : null}
          {node.agentType}
        </span>
        <span className={statusBadgeClass(node.status, styles)}>
          {node.status === 'done' ? (durationLabel(node) ?? 'done') : node.status}
        </span>
      </div>
      {node.kind === 'teammate' ? (
        <div className={styles.teammateMeta}>
          {node.team} · {t('ws.turns', { count: node.turns })}
        </div>
      ) : null}
      {node.prompt ? <div className={styles.cardPrompt}>{node.prompt}</div> : null}
      {node.feed.length > 0 ? (
        <div className={styles.cardFeed}>
          {node.feed.slice(-MINI_FEED_SIZE).map((ev) => (
            <div key={ev.toolUseId} className={styles.feedRow}>
              <span className={styles.feedTool}>{ev.toolName}</span>
              <span className={styles.feedSummary}>{ev.summary}</span>
            </div>
          ))}
          {node.feed.length > MINI_FEED_SIZE ? (
            <div className={styles.feedMore}>
              {t('ws.moreToolCalls', { count: node.feed.length - MINI_FEED_SIZE })}
            </div>
          ) : null}
        </div>
      ) : null}
      {node.status !== 'running' && node.result ? (
        <div className={styles.cardPrompt}>{node.result}</div>
      ) : null}
      {cost ? (
        <div className={styles.cardCost}>
          {model ? <span className={styles.cardCostModel}>{model}</span> : null}
          <span className={styles.cardCostTokens}>
            {fmtTokens(cost.total_tokens)} {t('ws.tokens')}
          </span>
          {cost.cost_usd != null ? (
            <span className={`${styles.cardCostUsd} ${costClassFor(cost.cost_usd, styles)}`}>
              {fmtUsd(cost.cost_usd)}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.cardId}>{node.id}</div>
    </div>
  )
}

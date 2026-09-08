import { X } from 'lucide-react'

import { useOnEscape } from '../../hooks/useOnEscape'
import { fmtTokens, fmtUsd, shortModel } from '../../lib/costFormat'
import { intlLocale, useT } from '../../lib/i18n'
import { useAgentCanvasStore } from '../../stores/agentCanvasStore'
import { useNodeCostStore } from '../../stores/nodeCostStore'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './AgentCanvasPOC.module.css'

/** Modal central com o feed completo do subagent selecionado no canvas. */
export function AgentModal() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const node = useAgentCanvasStore((s) =>
    s.selectedId ? (s.nodes.find((n) => n.id === s.selectedId) ?? null) : null,
  )
  const cost = useNodeCostStore((s) => (node ? (s.byNodeId[node.id] ?? null) : null))
  const select = useAgentCanvasStore((s) => s.select)

  useOnEscape(() => select(null), Boolean(node))

  if (!node) return null

  return (
    <div className={styles.modalBackdrop} onClick={() => select(null)}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <span className={styles.cardType}>{node.agentType}</span>
          <span
            className={
              node.status === 'running'
                ? styles.statusRunning
                : node.status === 'idle'
                  ? styles.statusIdle
                  : styles.statusDone
            }
          >
            {node.status}
          </span>
          {node.kind === 'teammate' ? (
            <span className={styles.teammateMeta}>
              {node.team} · {t('ws.turns', { count: node.turns })}
            </span>
          ) : null}
          <span className={styles.modalId}>{node.id}</span>
          <button type="button" className={styles.clearButton} onClick={() => select(null)}>
            <X size={14} />
          </button>
        </header>

        {node.prompt ? (
          <div className={styles.modalSection}>
            <div className={styles.modalSectionTitle}>{t('ws.task')}</div>
            <div className={styles.modalPrompt}>{node.prompt}</div>
          </div>
        ) : null}

        <div className={`${styles.modalSection} ${styles.modalFeedSection}`}>
          <div className={styles.modalSectionTitle}>
            {t('ws.feedToolCalls', { count: node.feed.length })}
          </div>
          <div className={styles.modalFeed}>
            {node.feed.length === 0 ? (
              <div className={styles.empty}>{t('ws.noToolCallYet')}</div>
            ) : (
              node.feed.map((ev) => (
                <div key={ev.toolUseId} className={styles.feedRow}>
                  <span className={styles.feedTime}>
                    {new Date(ev.ts).toLocaleTimeString(intlLocale(language))}
                  </span>
                  <span className={styles.feedTool}>{ev.toolName}</span>
                  <span className={styles.feedSummary}>{ev.summary}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {node.result ? (
          <div className={styles.modalSection}>
            <div className={styles.modalSectionTitle}>{t('ws.result')}</div>
            <div className={styles.modalResult}>{node.result}</div>
          </div>
        ) : null}

        {cost && cost.by_model.length > 0 ? (
          <div className={styles.modalSection}>
            <div className={styles.modalSectionTitle}>
              {t('ws.costBreakdown', {
                usd: cost.cost_usd != null ? fmtUsd(cost.cost_usd) : '—',
                tokens: fmtTokens(cost.total_tokens),
              })}
            </div>
            <div className={styles.modalCostList}>
              {cost.by_model.map((m) => (
                <div key={m.model} className={styles.modalCostRow}>
                  <span className={styles.cardCostModel}>{shortModel(m.model) ?? m.model}</span>
                  <span className={styles.feedSummary}>
                    {fmtTokens(
                      m.input + m.output + m.cache_read + m.cache_write_5m + m.cache_write_1h,
                    )}{' '}
                    {t('ws.tokens')}
                  </span>
                  <span className={styles.cardCostUsd}>
                    {m.cost_usd != null ? fmtUsd(m.cost_usd) : t('hud.noCost')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {node.transcriptPath ? (
          <div className={styles.modalTranscript}>{node.transcriptPath}</div>
        ) : null}
      </div>
    </div>
  )
}

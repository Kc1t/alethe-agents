import { GitBranch } from 'lucide-react'

import { useT } from '../../lib/i18n'
import type { Theme } from '../../lib/types'
import type { MergePhase } from '../../stores/mergeStore'
import { AgentIcon } from '../icons/AgentIcons'
import styles from './MergeTree.module.css'
import { deriveCardStatus, type GateResult, type PendingMergeCard } from './SidebarMergePanel'

type MergeTreeProps = {
  /** Já filtrado pelo pai: `visiblePendingMerges` do projeto ativo — a árvore
   *  troca sozinha quando o usuário troca de projeto na sidebar. */
  items: PendingMergeCard[]
  gateStatus: Record<string, GateResult>
  mergePhase: MergePhase
  activeCardId: string | null
  terminalTheme: Theme
  /** true quando há pendências em OUTROS projetos além do ativo — usado só
   *  pro texto do estado vazio, o badge global do painel já mostra a soma. */
  hasOtherProjectsPending: boolean
  onSelect: (item: PendingMergeCard) => void
}

const TONE_CLASS: Record<'working' | 'waiting' | 'offline' | 'stopped', string> = {
  working: styles.toneWorking,
  waiting: styles.toneWaiting,
  offline: styles.toneOffline,
  stopped: styles.toneStopped,
}

/** Árvore compacta: um ponto de status + ícone/nome do agente + status curto
 *  por worktree, conectados por uma linha decorativa até um nó "main" fixo
 *  no fim — representa os terminais/worktrees abertos do projeto ativo, não
 *  topologia git real (sem ahead/behind). Clicar numa linha abre o popup de
 *  detalhe (MergeCenterModal) com o card completo de sempre. */
export function MergeTree({
  items,
  gateStatus,
  mergePhase,
  activeCardId,
  terminalTheme,
  hasOtherProjectsPending,
  onSelect,
}: MergeTreeProps) {
  const t = useT()

  if (items.length === 0) {
    return (
      <div className={styles.emptyState}>
        {hasOtherProjectsPending ? t('merge.treeEmptyForProject') : t('merge.panelEmpty')}
      </div>
    )
  }

  return (
    <div className={styles.tree}>
      <div className={styles.trunk} />
      {items.map((item) => {
        const status = deriveCardStatus(gateStatus[item.id], item.id === activeCardId, mergePhase)
        return (
          <button key={item.id} type="button" className={styles.node} onClick={() => onSelect(item)}>
            <span className={styles.connector} />
            <span className={`${styles.dot} ${TONE_CLASS[status.tone]}`} />
            <span className={styles.nodeContent}>
              <span className={styles.nodeIcon}>
                <AgentIcon type={item.agentType} size={14} theme={terminalTheme} />
              </span>
              <span className={styles.nodeText}>
                <span className={styles.nodeName}>{item.agentName}</span>
                <span className={styles.nodeStatus}>{t(status.key)}</span>
              </span>
            </span>
          </button>
        )
      })}
      <div className={styles.mainNode}>
        <span className={styles.mainDot} />
        <GitBranch size={11} />
        <span>{t('merge.treeMainNode')}</span>
      </div>
    </div>
  )
}

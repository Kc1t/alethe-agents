import { Check, Mic, Trash2 } from 'lucide-react'

import { agentLabel } from '../../lib/agentProviders'
import { type MessageKey, useT } from '../../lib/i18n'
import { WARNINGS } from '../../lib/voiceCommand'
import { useVoiceHistoryStore, type VoiceHistoryStatus } from '../../stores/voiceHistoryStore'
import styles from './VoiceHistoryPanel.module.css'

const STATUS_KEYS: Record<VoiceHistoryStatus, MessageKey> = {
  deciding: 'voice.history.status.deciding',
  ran: 'voice.history.status.ran',
  waiting: 'voice.history.status.waiting',
  blocked: 'voice.history.status.blocked',
  failed: 'voice.history.status.failed',
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function VoiceHistoryPanel() {
  const t = useT()
  const entries = useVoiceHistoryStore((state) => state.entries)
  const clear = useVoiceHistoryStore((state) => state.clear)

  return (
    <section className={styles.sidebar}>
      <header className={styles.header}>
        <span className={styles.heading}>
          <Mic size={15} />
          Jev
        </span>
        <button
          type="button"
          className={styles.clearButton}
          onClick={clear}
          disabled={entries.length === 0}
          title={t('voice.history.clear')}
          aria-label={t('voice.history.clear')}
        >
          <Trash2 size={14} />
        </button>
      </header>

      <div className={styles.content}>
        {entries.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Mic size={18} />
            </span>
            <strong>{t('voice.history.emptyTitle')}</strong>
            <span>{t('voice.history.emptyBody')}</span>
          </div>
        ) : (
          <ol className={styles.list}>
            {entries.map((entry) => {
              const jobs =
                entry.plan?.kind === 'spawn'
                  ? entry.plan.jobs.filter((job) => job.prompt)
                  : entry.plan?.kind === 'reuse' && entry.plan.prompt
                    ? [{ agent: null, prompt: entry.plan.prompt }]
                    : []
              return (
                <li key={entry.id} className={styles.card} data-status={entry.status}>
                  <div className={styles.cardTop}>
                    <span className={styles.badge}>{t(STATUS_KEYS[entry.status])}</span>
                    <span className={styles.time}>{clock(entry.at)}</span>
                  </div>

                  <p className={styles.title}>{entry.summary}</p>
                  <p className={styles.meta}>{entry.spoken}</p>

                  {jobs.map((job, index) => (
                    <p key={`${job.agent ?? 'reuse'}-${index}`} className={styles.prompt}>
                      {job.agent ? `${agentLabel(job.agent)}: ` : ''}
                      {job.prompt}
                    </p>
                  ))}

                  {entry.warnings.map((warning) => (
                    <p key={warning} className={styles.note}>
                      {t(WARNINGS[warning])}
                    </p>
                  ))}

                  {entry.actions.length > 0 ? (
                    <ul className={styles.actions}>
                      {entry.actions.map((action, index) => (
                        <li key={index}>
                          <Check size={11} aria-hidden />
                          <span>{action}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {entry.error ? <p className={styles.error}>{entry.error}</p> : null}

                  {entry.decision ? (
                    <div className={styles.numbers}>
                      <span>
                        {entry.decision.action.choice} {entry.decision.action.confidence.toFixed(2)}
                      </span>
                      <span>
                        {t('voice.history.agentConf', {
                          value: entry.decision.agent.confidence.toFixed(2),
                        })}
                      </span>
                      {entry.transcribeMs === null ? null : (
                        <span>{t('voice.history.voiceMs', { ms: entry.transcribeMs })}</span>
                      )}
                      {entry.decideMs === null ? null : <span>jev {entry.decideMs} ms</span>}
                      <span>US$ {entry.decision.costUsd.toFixed(6)}</span>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </section>
  )
}

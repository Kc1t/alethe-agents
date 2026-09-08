import { Check, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { groupServersByName, isAgentReadable, mcpErrorKey } from '../../../lib/mcp'
import { mcpScan, mcpSync } from '../../../lib/tauri'
import type { McpAgentSnapshot } from '../../../lib/types'
import { AGENT_TYPE_LABELS } from '../../../lib/types'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import styles from './McpStep.module.css'

export function McpStep() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const [snapshots, setSnapshots] = useState<McpAgentSnapshot[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [synced, setSynced] = useState(0)

  const scan = useCallback(async () => {
    try {
      setSnapshots(await mcpScan('global'))
    } catch {
      setSnapshots([])
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const groups = groupServersByName(snapshots ?? [])
  const gaps = groups.filter((group) => group.missingAgents.length > 0)
  const covered = (snapshots ?? []).filter(
    (snapshot) => isAgentReadable(snapshot) && snapshot.servers.length > 0,
  ).length

  const syncEverything = async () => {
    setBusy(true)
    let written = 0
    const failures: string[] = []
    for (const group of gaps) {
      try {
        const outcomes = await mcpSync(
          group.records[0].agent,
          group.missingAgents,
          'global',
          null,
          group.name,
        )
        written += outcomes.filter((outcome) => outcome.status === 'written').length
        for (const outcome of outcomes) {
          if (outcome.status === 'failed' && outcome.error) {
            failures.push(t(mcpErrorKey(outcome.error)))
          }
        }
      } catch (error) {
        failures.push(t(mcpErrorKey(error instanceof Error ? error.message : String(error))))
      }
    }
    setSynced(written)
    if (failures.length > 0) {
      pushToast({ title: t('mcp.writeFailed'), body: [...new Set(failures)].join(' ') })
    }
    await scan()
    setBusy(false)
  }

  return (
    <div className={styles.step}>
      <div className={styles.intro}>
        <h2 className={styles.title}>{t('onboarding.mcpTitle')}</h2>
        <p className={styles.subtitle}>{t('onboarding.mcpSubtitle')}</p>
      </div>

      <div className={styles.stats}>
        <span className={styles.stat}>
          <i className={styles.dotAccent} />
          <b>{groups.length}</b> {t('onboarding.mcpStatServers')}
        </span>
        <span className={styles.stat}>
          <i className={styles.dotOk} />
          <b>{covered}</b> {t('onboarding.mcpStatAgents')}
        </span>
        <span className={styles.stat}>
          <i className={gaps.length > 0 ? styles.dotWarn : styles.dot} />
          <b>{gaps.length}</b> {t('onboarding.mcpStatGaps')}
        </span>
      </div>

      <div className={styles.list}>
        {snapshots === null ? (
          <div className={styles.empty}>{t('onboarding.mcpScanning')}</div>
        ) : (
          (snapshots ?? []).map((snapshot) => {
            const readable = isAgentReadable(snapshot)
            const found = snapshot.sources.some((source) => source.exists)
            return (
              <div key={snapshot.agent} className={styles.row}>
                <span className={styles.agent}>{AGENT_TYPE_LABELS[snapshot.agent]}</span>
                <span className={styles.count}>
                  {snapshot.servers.length > 0
                    ? t('onboarding.mcpServerCount', { count: snapshot.servers.length })
                    : ''}
                </span>
                <span
                  className={`${styles.tag} ${
                    !readable ? styles.tagWarn : found ? styles.tagOk : styles.tagIdle
                  }`}
                >
                  <i />
                  {!readable
                    ? t('mcp.diagUnreadable')
                    : found
                      ? t('onboarding.mcpConfigFound')
                      : t('mcp.diagMissing')}
                </span>
              </div>
            )
          })
        )}
      </div>

      {groups.length === 0 && snapshots !== null ? (
        <p className={styles.note}>{t('onboarding.mcpNothingYet')}</p>
      ) : gaps.length > 0 ? (
        <div className={styles.action}>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void syncEverything()}
            disabled={busy}
          >
            {busy ? <RefreshCw size={13} className={styles.spinning} /> : null}
            {t('onboarding.mcpSyncAll', { count: gaps.length })}
          </button>
          <span>{t('onboarding.mcpSyncHint')}</span>
        </div>
      ) : (
        <p className={styles.note}>
          <Check size={13} />{' '}
          {synced > 0 ? t('onboarding.mcpSynced', { count: synced }) : t('onboarding.mcpAligned')}
        </p>
      )}
    </div>
  )
}

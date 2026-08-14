import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../../lib/i18n'
import { isMacOS } from '../../../lib/platform'
import { countLiveResumablePanes, resetLastSession } from '../../../lib/resetLastSession'
import type { AgentType } from '../../../lib/types'
import { SPAWN_CONCURRENCY_LIMITS, useProjectsStore } from '../../../stores/projectsStore'
import {
  clampResourceMemoryBudget,
  RESOURCE_MEMORY_BUDGET_LIMITS,
} from '../../../stores/projectsStore.constants'
import { useUiStore } from '../../../stores/uiStore'
import { AgentIcon } from '../../icons/AgentIcons'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

const AGENTS: { id: AgentType; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'freebuff', label: 'Freebuff' },
  { id: 'mimo', label: 'Mimo Code' },
]

export function TerminalPage({ enabledCount }: { enabledCount: number }) {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setAgentEnabled = useProjectsStore((state) => state.setAgentEnabled)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const pushToast = useUiStore((state) => state.pushToast)
  const [resetting, setResetting] = useState(false)
  const concurrency = preferences.spawnConcurrency
  const resourcePolicy = preferences.resourcePolicy
  const effectiveResourceMode =
    resourcePolicy.automaticParkingOptIn === true && resourcePolicy.mode === 'smart-lru'
      ? 'smart-lru'
      : 'manual'
  const setResourcePolicy = (patch: Partial<typeof resourcePolicy>) => {
    const next = { ...resourcePolicy, ...patch }
    next.memoryBudgetMb = clampResourceMemoryBudget(next.memoryBudgetMb)
    next.warningThresholdMb = Math.min(
      next.memoryBudgetMb - 64,
      Math.max(512, Math.round(next.warningThresholdMb)),
    )
    next.recoveryTargetMb = Math.min(
      next.warningThresholdMb - 64,
      Math.max(384, Math.round(next.recoveryTargetMb)),
    )
    next.hiddenAgentIdleMinutes = Math.min(
      240,
      Math.max(5, Math.round(next.hiddenAgentIdleMinutes)),
    )
    next.hiddenShellIdleMinutes = Math.min(
      480,
      Math.max(5, Math.round(next.hiddenShellIdleMinutes)),
    )
    setPreferences({ resourcePolicy: next })
  }
  const setConcurrency = (n: number) =>
    setPreferences({
      spawnConcurrency: Math.min(
        SPAWN_CONCURRENCY_LIMITS.max,
        Math.max(SPAWN_CONCURRENCY_LIMITS.min, n),
      ),
    })

  const onResetLastSession = async () => {
    if (resetting) return
    const count = countLiveResumablePanes()
    if (count === 0) {
      pushToast({ title: t('prefs.resetSessionEmpty'), body: t('prefs.resetSessionEmptyBody') })
      return
    }
    // Abrange TODOS os projetos/grupos com agente vivo em background, não só
    // o visível — com vários acumulados isso reinicia muitos processos de
    // uma vez, então confirma explicitamente mostrando a contagem real.
    if (count > 1 && !window.confirm(t('prefs.resetSessionConfirm', { count }))) return
    setResetting(true)
    try {
      const { resumed, total } = await resetLastSession()
      if (total === 0) {
        pushToast({ title: t('prefs.resetSessionEmpty'), body: t('prefs.resetSessionEmptyBody') })
      } else {
        pushToast({
          title: t('prefs.resetSessionDone'),
          body: t('prefs.resetSessionDoneBody', { count: resumed }),
        })
      }
    } catch (err) {
      pushToast({ title: t('prefs.resetSessionFailed'), body: String(err) })
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <SettingsSection
        id="resource-policy"
        title={t('prefs.resourcePolicy')}
        description={t('prefs.resourcePolicyDesc')}
      >
        <div className={styles.resourceControls}>
          <div className={styles.segmented}>
            <button
              type="button"
              className={effectiveResourceMode === 'smart-lru' ? styles.segmentActive : undefined}
              onClick={() => setResourcePolicy({ mode: 'smart-lru', automaticParkingOptIn: true })}
            >
              {t('prefs.resourcePolicySmart')}
            </button>
            <button
              type="button"
              className={effectiveResourceMode === 'manual' ? styles.segmentActive : undefined}
              onClick={() => setResourcePolicy({ mode: 'manual', automaticParkingOptIn: false })}
            >
              {t('prefs.resourcePolicyManual')}
            </button>
          </div>
          <div className={styles.resourceGrid}>
            <label>
              <span>{t('prefs.resourceBudget')}</span>
              <input
                type="number"
                min={RESOURCE_MEMORY_BUDGET_LIMITS.min}
                max={RESOURCE_MEMORY_BUDGET_LIMITS.max}
                step={RESOURCE_MEMORY_BUDGET_LIMITS.step}
                value={resourcePolicy.memoryBudgetMb}
                onChange={(event) =>
                  setResourcePolicy({ memoryBudgetMb: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceWarning')}</span>
              <input
                type="number"
                min={512}
                max={resourcePolicy.memoryBudgetMb - 64}
                step={64}
                value={resourcePolicy.warningThresholdMb}
                onChange={(event) =>
                  setResourcePolicy({ warningThresholdMb: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceRecovery')}</span>
              <input
                type="number"
                min={384}
                max={resourcePolicy.warningThresholdMb - 64}
                step={64}
                value={resourcePolicy.recoveryTargetMb}
                onChange={(event) =>
                  setResourcePolicy({ recoveryTargetMb: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceAgentIdle')}</span>
              <input
                type="number"
                min={5}
                max={240}
                step={5}
                value={resourcePolicy.hiddenAgentIdleMinutes}
                onChange={(event) =>
                  setResourcePolicy({ hiddenAgentIdleMinutes: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceShellIdle')}</span>
              <input
                type="number"
                min={5}
                max={480}
                step={5}
                value={resourcePolicy.hiddenShellIdleMinutes}
                onChange={(event) =>
                  setResourcePolicy({ hiddenShellIdleMinutes: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <p className={styles.resourceHint}>
            {effectiveResourceMode === 'smart-lru'
              ? t('prefs.resourcePolicySmartHint')
              : t('prefs.resourcePolicyManualHint')}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        id="spawn-concurrency"
        title={t('prefs.spawnConcurrency')}
        description={t('prefs.spawnConcurrencyDesc')}
      >
        <div className={styles.zoomControl}>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency - SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency <= SPAWN_CONCURRENCY_LIMITS.min}
            aria-label={t('prefs.spawnConcurrencyDecrease')}
          >
            <Minus size={15} />
          </button>
          <strong>{concurrency}</strong>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency + SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency >= SPAWN_CONCURRENCY_LIMITS.max}
            aria-label={t('prefs.spawnConcurrencyIncrease')}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setConcurrency(3)}
            disabled={concurrency === 3}
            aria-label={t('prefs.spawnConcurrencyReset')}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="agents"
        title={t('prefs.enabledAgents', { count: enabledCount })}
        description={t('prefs.agentsDesc')}
      >
        <div className={styles.agentList}>
          {AGENTS.map((agent) => {
            const checked = preferences.enabledAgents[agent.id]
            const disabled = checked && enabledCount === 1
            return (
              <label key={agent.id} className={disabled ? styles.agentDisabled : undefined}>
                <span className={styles.agentIcon}>
                  <AgentIcon
                    type={agent.id}
                    size={20}
                    theme={preferences.terminalTheme ?? preferences.uiTheme}
                  />
                </span>
                <span className={styles.agentCopy}>
                  <strong>{agent.label}</strong>
                  <span>{t(`agent.${agent.id}.desc`)}</span>
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => setAgentEnabled(agent.id, event.target.checked)}
                />
              </label>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        id="limit-reset-notify"
        title={t('prefs.limitResetNotify')}
        description={t('prefs.limitResetNotifyDesc')}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.notifyOnLimitReset ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ notifyOnLimitReset: true })}
          >
            {t('prefs.limitResetNotifyOn')}
          </button>
          <button
            type="button"
            className={!preferences.notifyOnLimitReset ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ notifyOnLimitReset: false })}
          >
            {t('prefs.limitResetNotifyOff')}
          </button>
        </div>
      </SettingsSection>

      {isMacOS() ? (
        <SettingsSection
          id="native-terminal-macos"
          title={t('prefs.nativeTerminalMacos')}
          description={t('prefs.nativeTerminalMacosDesc')}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 12px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              background: 'var(--bg-sunken)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={preferences.nativeTerminalMacos ?? false}
              onChange={(e) => setPreferences({ nativeTerminalMacos: e.target.checked })}
            />
            <span style={{ flex: 1, fontSize: 13 }}>{t('prefs.nativeTerminalMacosEnable')}</span>
          </label>
        </SettingsSection>
      ) : null}

      <SettingsSection
        id="reset-session"
        title={t('prefs.resetSession')}
        description={t('prefs.resetSessionDesc')}
      >
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void onResetLastSession()}
          disabled={resetting}
        >
          <RotateCcw size={15} />
          {resetting ? t('prefs.resetSessionBusy') : t('prefs.resetSessionButton')}
        </button>
      </SettingsSection>
    </>
  )
}

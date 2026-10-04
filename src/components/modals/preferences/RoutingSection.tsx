import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useState } from 'react'

import { agentLabel } from '../../../lib/agentProviders'
import { useT } from '../../../lib/i18n'
import type { MessageKey } from '../../../lib/i18n/messages/en'
import {
  canFallBackToName,
  ROUTING_EFFORT_CLASSES,
  ROUTING_KINDS,
} from '../../../lib/orchestrationSettings'
import { applyRoutingPreset, ROUTING_PRESET_IDS } from '../../../lib/routingPresets'
import type {
  DelegateKind,
  EffortClass,
  OrchestrationRole,
  QuotaGate,
  RoutingPresetId,
  RoutingRule,
  RoutingSettings,
} from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import controls from '../controls.module.css'
import { SettingsSection } from './primitives'
import styles from './RoutingSection.module.css'

const PRESET_LABEL: Record<Exclude<RoutingPresetId, 'custom'>, MessageKey> = {
  economy: 'prefs.routingPresetEconomy',
  balanced: 'prefs.routingPresetBalanced',
  performance: 'prefs.routingPresetPerformance',
}
const PRESET_DESC: Record<Exclude<RoutingPresetId, 'custom'>, MessageKey> = {
  economy: 'prefs.routingPresetEconomyDesc',
  balanced: 'prefs.routingPresetBalancedDesc',
  performance: 'prefs.routingPresetPerformanceDesc',
}
const KIND_LABEL: Record<DelegateKind, MessageKey> = {
  research: 'prefs.routingKindResearch',
  code: 'prefs.routingKindCode',
  review: 'prefs.routingKindReview',
  command: 'prefs.routingKindCommand',
  scrap: 'prefs.routingKindScrap',
  docs: 'prefs.routingKindDocs',
}
const EFFORT_LABEL: Record<EffortClass, MessageKey> = {
  light: 'prefs.routingEffortLight',
  standard: 'prefs.routingEffortStandard',
  deep: 'prefs.routingEffortDeep',
}
const WINDOW_LABEL: Record<QuotaGate['window'], MessageKey> = {
  short: 'prefs.routingWindowShort',
  week: 'prefs.routingWindowWeek',
  opus: 'prefs.routingWindowOpus',
}
const BOTH_CRITICAL_LABEL: Record<RoutingSettings['onBothCritical'], MessageKey> = {
  ask: 'prefs.routingOnBothCriticalAsk',
  'run-cheapest': 'prefs.routingOnBothCriticalRunCheapest',
  block: 'prefs.routingOnBothCriticalBlock',
}
const BOTH_CRITICAL_DESC: Record<RoutingSettings['onBothCritical'], MessageKey> = {
  ask: 'prefs.routingOnBothCriticalAskDesc',
  'run-cheapest': 'prefs.routingOnBothCriticalRunCheapestDesc',
  block: 'prefs.routingOnBothCriticalBlockDesc',
}

/** A whole percent within [min, max], or undefined when the input is empty or out of range. */
function percentFrom(raw: string, min: number, max: number): number | undefined {
  if (raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined
}

const toggleValue = <T,>(list: T[], value: T): T[] =>
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]

export function RoutingSection() {
  const t = useT()
  const settings = useProjectsStore((state) => state.preferences.orchestration)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  // The rule list is long, so it stays folded until asked for.
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const routing = settings.routing
  const roleNames = [...new Set(settings.roles.map((role) => role.name))]

  const saveRouting = (patch: Partial<RoutingSettings>) =>
    setPreferences({ orchestration: { ...settings, routing: { ...routing, ...patch } } })
  // Any hand edit of the rules leaves the preset world behind.
  const saveRules = (rules: RoutingRule[]) => saveRouting({ rules, preset: 'custom' })

  const applyPreset = (presetId: Exclude<RoutingPresetId, 'custom'>) => {
    const next = applyRoutingPreset(presetId, settings.roles)
    // Preset roles redefine names a kept role may fall back to, so revalidate fallbacks.
    const roles = next.roles.map((role: OrchestrationRole) =>
      role.fallback && !canFallBackToName(role, role.fallback, next.roles)
        ? { ...role, fallback: null }
        : role,
    )
    setPreferences({
      orchestration: { ...settings, roles, routing: { ...routing, rules: next.rules, preset: presetId } },
    })
  }

  const patchRule = (id: string, patch: Partial<RoutingRule>) =>
    saveRules(routing.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)))

  const moveRule = (index: number, delta: -1 | 1) => {
    const rules = [...routing.rules]
    const [rule] = rules.splice(index, 1)
    rules.splice(index + delta, 0, rule)
    saveRules(rules)
  }

  const addRule = () =>
    saveRules([
      ...routing.rules,
      { id: nanoid(8), enabled: true, kinds: [], efforts: [], gates: [], role: roleNames[0] },
    ])

  return (
    <SettingsSection
      id="orchestration-routing"
      title={t('prefs.orchestrationRouting')}
      description={t('prefs.orchestrationRoutingDesc')}
    >
      <p className={controls.hint}>{t('prefs.orchestrationRoutingIntro')}</p>

      <div className={styles.presets}>
        {ROUTING_PRESET_IDS.map((presetId) => (
          <button
            key={presetId}
            type="button"
            aria-pressed={routing.preset === presetId}
            className={`${controls.modeChoice} ${
              routing.preset === presetId ? controls.modeChoiceActive : ''
            }`}
            onClick={() => applyPreset(presetId)}
          >
            <span className={controls.modeChoiceIndicator} aria-hidden />
            <span className={controls.modeChoiceBody}>
              <strong>{t(PRESET_LABEL[presetId])}</strong>
              <small>{t(PRESET_DESC[presetId])}</small>
            </span>
          </button>
        ))}
        <button
          type="button"
          disabled
          aria-pressed={routing.preset === 'custom'}
          title={t('prefs.routingCustomHint')}
          className={`${controls.modeChoice} ${
            routing.preset === 'custom' ? controls.modeChoiceActive : ''
          }`}
        >
          <span className={controls.modeChoiceIndicator} aria-hidden />
          <span className={controls.modeChoiceBody}>
            <strong>{t('prefs.routingPresetCustom')}</strong>
            <small>{t('prefs.routingPresetCustomDesc')}</small>
          </span>
        </button>
      </div>

      <div className={styles.globals}>
        <label className={controls.field}>
          <span className={controls.label}>{t('prefs.routingCriticalThreshold')}</span>
          <input
            className={controls.input}
            type="number"
            min={10}
            max={99}
            step={1}
            value={routing.criticalThreshold}
            onChange={(event) => {
              const percent = percentFrom(event.target.value, 10, 99)
              if (percent !== undefined) saveRouting({ criticalThreshold: percent })
            }}
          />
          <span className={controls.hint}>{t('prefs.routingCriticalThresholdHint')}</span>
        </label>
        <div className={controls.field}>
          <span className={controls.label}>{t('prefs.routingAllowOpusOnDeep')}</span>
          <button
            type="button"
            role="switch"
            className={styles.switch}
            aria-checked={routing.allowOpusOnDeep}
            aria-label={t('prefs.routingAllowOpusOnDeep')}
            onClick={() => saveRouting({ allowOpusOnDeep: !routing.allowOpusOnDeep })}
          />
          <span className={controls.hint}>{t('prefs.routingAllowOpusOnDeepHint')}</span>
        </div>
        <div className={controls.field}>
          <span className={controls.label}>{t('prefs.routingOnBothCritical')}</span>
          <Dropdown
            value={routing.onBothCritical}
            ariaLabel={t('prefs.routingOnBothCritical')}
            options={(
              ['ask', 'run-cheapest', 'block'] as RoutingSettings['onBothCritical'][]
            ).map((value) => ({ value, label: t(BOTH_CRITICAL_LABEL[value]) }))}
            onChange={(value) =>
              saveRouting({ onBothCritical: value as RoutingSettings['onBothCritical'] })
            }
          />
          <span className={controls.hint}>{t(BOTH_CRITICAL_DESC[routing.onBothCritical])}</span>
        </div>
      </div>

      <button
        type="button"
        className={styles.advancedToggle}
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('prefs.routingAdvanced', { count: routing.rules.length })}
      </button>

      {advancedOpen ? (
        <div className={styles.rules}>
          <p className={controls.hint}>{t('prefs.routingRulesHint')}</p>
          {routing.rules.map((rule, index) => {
            const n = index + 1
            const roleMissing = !roleNames.includes(rule.role)
            const roleOptions = roleMissing
              ? [{ value: rule.role, label: rule.role }, ...roleNames.map((name) => ({ value: name, label: name }))]
              : roleNames.map((name) => ({ value: name, label: name }))
            return (
              <div key={rule.id} className={styles.rule}>
                <div className={styles.ruleHeader}>
                  <button
                    type="button"
                    role="switch"
                    className={styles.switch}
                    aria-checked={rule.enabled}
                    aria-label={t('prefs.routingRuleEnabled', { n })}
                    onClick={() => patchRule(rule.id, { enabled: !rule.enabled })}
                  />
                  <Dropdown
                    value={rule.role}
                    ariaLabel={t('prefs.routingRuleRole', { n })}
                    options={roleOptions}
                    onChange={(value) => patchRule(rule.id, { role: value })}
                  />
                  <span className={styles.ruleHeaderSpacer} />
                  <button
                    type="button"
                    className={controls.iconBtnSm}
                    aria-label={t('prefs.routingRuleMoveUp', { n })}
                    disabled={index === 0}
                    onClick={() => moveRule(index, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className={controls.iconBtnSm}
                    aria-label={t('prefs.routingRuleMoveDown', { n })}
                    disabled={index === routing.rules.length - 1}
                    onClick={() => moveRule(index, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    className={controls.iconBtnSm}
                    aria-label={t('prefs.routingRuleRemove', { n })}
                    onClick={() => saveRules(routing.rules.filter((other) => other.id !== rule.id))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {roleMissing ? (
                  <p className={styles.warning}>
                    {t('prefs.routingRuleRoleMissing', { name: rule.role })}
                  </p>
                ) : null}

                <div className={styles.ruleGroup}>
                  <span className={controls.label}>{t('prefs.routingRuleKinds')}</span>
                  <div className={styles.chipRow}>
                    {ROUTING_KINDS.map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        aria-pressed={rule.kinds.includes(kind)}
                        className={`${styles.chip} ${
                          rule.kinds.includes(kind) ? styles.chipActive : ''
                        }`}
                        onClick={() => patchRule(rule.id, { kinds: toggleValue(rule.kinds, kind) })}
                      >
                        {t(KIND_LABEL[kind])}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.ruleGroup}>
                  <span className={controls.label}>{t('prefs.routingRuleEfforts')}</span>
                  <div className={styles.chipRow}>
                    {ROUTING_EFFORT_CLASSES.map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        aria-pressed={rule.efforts.includes(effort)}
                        className={`${styles.chip} ${
                          rule.efforts.includes(effort) ? styles.chipActive : ''
                        }`}
                        onClick={() =>
                          patchRule(rule.id, { efforts: toggleValue(rule.efforts, effort) })
                        }
                      >
                        {t(EFFORT_LABEL[effort])}
                      </button>
                    ))}
                  </div>
                  <span className={controls.hint}>{t('prefs.routingMatchAny')}</span>
                </div>

                <div className={styles.ruleGroup}>
                  <span className={controls.label}>{t('prefs.routingRuleGates')}</span>
                  {rule.gates.map((gate, gateIndex) => (
                    <div key={gateIndex} className={styles.gate}>
                      <Dropdown
                        value={gate.agent}
                        ariaLabel={t('prefs.routingRuleGateAgent')}
                        options={(['claude', 'codex'] as QuotaGate['agent'][]).map((agent) => ({
                          value: agent,
                          label: agentLabel(agent),
                        }))}
                        onChange={(value) =>
                          patchRule(rule.id, {
                            gates: rule.gates.map((other, i) =>
                              i === gateIndex ? { ...other, agent: value as QuotaGate['agent'] } : other,
                            ),
                          })
                        }
                      />
                      <Dropdown
                        value={gate.window}
                        ariaLabel={t('prefs.routingRuleGateWindow')}
                        options={(['short', 'week', 'opus'] as QuotaGate['window'][]).map(
                          (window) => ({ value: window, label: t(WINDOW_LABEL[window]) }),
                        )}
                        onChange={(value) =>
                          patchRule(rule.id, {
                            gates: rule.gates.map((other, i) =>
                              i === gateIndex
                                ? { ...other, window: value as QuotaGate['window'] }
                                : other,
                            ),
                          })
                        }
                      />
                      <input
                        className={controls.input}
                        type="number"
                        min={1}
                        max={99}
                        step={1}
                        value={gate.below}
                        aria-label={t('prefs.routingRuleGateBelow')}
                        onChange={(event) => {
                          const percent = percentFrom(event.target.value, 1, 99)
                          if (percent === undefined) return
                          patchRule(rule.id, {
                            gates: rule.gates.map((other, i) =>
                              i === gateIndex ? { ...other, below: percent } : other,
                            ),
                          })
                        }}
                      />
                      <button
                        type="button"
                        className={controls.iconBtnSm}
                        aria-label={t('prefs.routingRuleGateRemove')}
                        onClick={() =>
                          patchRule(rule.id, {
                            gates: rule.gates.filter((_, i) => i !== gateIndex),
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm}`}
                    onClick={() =>
                      patchRule(rule.id, {
                        gates: [...rule.gates, { agent: 'claude', window: 'short', below: 50 }],
                      })
                    }
                  >
                    <Plus size={13} />
                    {t('prefs.routingRuleGateAdd')}
                  </button>
                </div>
              </div>
            )
          })}
          <button
            type="button"
            className={`${controls.btn} ${controls.btnSm}`}
            disabled={roleNames.length === 0}
            title={roleNames.length === 0 ? t('prefs.routingRulesNeedRole') : undefined}
            onClick={addRule}
          >
            <Plus size={14} />
            {t('prefs.routingRuleAdd')}
          </button>
          {roleNames.length === 0 ? (
            <p className={controls.hint}>{t('prefs.routingRulesNeedRole')}</p>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  )
}

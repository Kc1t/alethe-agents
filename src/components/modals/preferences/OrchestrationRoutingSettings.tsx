import { GripVertical, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAgentFitness } from '../../../hooks/useAgentFitness'
import { useOrchestratorSnapshot } from '../../../hooks/useOrchestratorSnapshot'
import { useProviderModels } from '../../../hooks/useProviderModels'
import { effortLevelsForModel, isValidModelName } from '../../../lib/agentLaunchDefaults'
import { agentLabel } from '../../../lib/agentProviders'
import { type MessageKey, useT } from '../../../lib/i18n'
import {
  normalizeOrchestratorPolicy,
  normalizeOrchestratorRouting,
} from '../../../lib/orchestratorPolicy'
import { pickRoute, routePressure } from '../../../lib/orchestratorRouting'
import { moveItem } from '../../../lib/reorder'
import {
  type AgentEffortLevel,
  ORCHESTRATOR_MAX_ROUTES,
  ORCHESTRATOR_ROUTING_PRESETS,
  type OrchestratorRoute,
  type OrchestratorRoutingPreset,
  type OrchestratorTaskComplexity,
} from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { Dropdown } from '../../ui/Dropdown'
import { type SortableDrag, SortableList } from '../../ui/SortableList'
import { ModelSearchablePicker } from '../ModelSearchablePicker'
import prefs from '../PreferencesModal.module.css'
import styles from './OrchestrationRoutingSettings.module.css'

const COMPLEXITIES: readonly OrchestratorTaskComplexity[] = ['light', 'standard', 'deep']
const LIMITS = ['watchPercent', 'protectPercent', 'criticalPercent'] as const
const ROUTE_AGENTS: readonly OrchestratorRoute['agent'][] = ['claude', 'codex']
const EFFORT_LABEL_KEYS: Record<AgentEffortLevel, MessageKey> = {
  none: 'prefs.agentDefaultsEffortNone',
  minimal: 'prefs.agentDefaultsEffortMinimal',
  low: 'prefs.agentDefaultsEffortLow',
  medium: 'prefs.agentDefaultsEffortMedium',
  high: 'prefs.agentDefaultsEffortHigh',
  xhigh: 'prefs.agentDefaultsEffortXhigh',
  max: 'prefs.agentDefaultsEffortMax',
  ultra: 'prefs.agentDefaultsEffortUltra',
}

type RouteEditorProps = {
  route: OrchestratorRoute
  position: number
  drag: SortableDrag
  removable: boolean
  /** How used the route's provider is right now; null before the first reading. */
  usage: number | null
  /** Whether the route's CLI was found on this machine. */
  installed: boolean
  /** Whether a task of this tier would start on this route right now. */
  next: boolean
  bands: { watchPercent: number; protectPercent: number; criticalPercent: number }
  onChange: (route: OrchestratorRoute) => void
  onRemove: () => void
}

function RouteEditor({
  route,
  position,
  drag,
  removable,
  usage,
  installed,
  next,
  bands,
  onChange,
  onRemove,
}: RouteEditorProps) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const { models, all, loading } = useProviderModels(route.agent)
  const efforts = effortLevelsForModel(route.agent, route.model, all, route.effort)
  const provider = agentLabel(route.agent)
  const label = String(position)
  const band =
    usage === null
      ? undefined
      : usage >= bands.criticalPercent
        ? 'critical'
        : usage >= bands.watchPercent
          ? 'watch'
          : 'ok'
  return (
    <div
      className={styles.route}
      data-dragging={drag.dragging ? 'true' : undefined}
      data-next={next ? 'true' : undefined}
    >
      <button
        type="button"
        className={styles.grip}
        {...drag.handleProps}
        title={t('prefs.orchestrationRouteDrag')}
        aria-label={t('prefs.orchestrationRouteDrag')}
      >
        <GripVertical size={13} />
      </button>
      <span className={styles.position}>{position}</span>
      <div className={styles.provider}>
        <Dropdown
          value={route.agent}
          options={ROUTE_AGENTS.map((agent) => ({
            value: agent,
            label: agentLabel(agent),
          }))}
          onChange={(agent) =>
            onChange({ agent: agent as OrchestratorRoute['agent'], model: '', effort: 'medium' })
          }
          ariaLabel={t('prefs.orchestrationRouteProvider', { position: label })}
        />
      </div>
      <div className={styles.model}>
        <ModelSearchablePicker
          value={route.model ?? ''}
          onChange={(value) => {
            const model = value.trim()
            // The same rule the worker defaults apply: a name the CLI could not take is refused
            // here, where the person can see why, instead of being dropped when a worker starts.
            if (model && !isValidModelName(model)) {
              pushToast({
                title: t('prefs.agentDefaultsInvalidModel'),
                body: t('prefs.agentDefaultsInvalidModelBody', { model }),
              })
              return
            }
            onChange({ ...route, model })
          }}
          options={models}
          loading={loading}
          providerName={provider}
          placeholder={t('prefs.agentDefaultsModelDefault')}
        />
      </div>
      <div className={styles.effort}>
        <Dropdown
          value={route.effort ?? ''}
          options={efforts.map((effort) => ({
            value: effort,
            label: t(EFFORT_LABEL_KEYS[effort]),
          }))}
          onChange={(effort) => onChange({ ...route, effort: effort as AgentEffortLevel })}
          ariaLabel={t('prefs.orchestrationRouteEffort', { route: label })}
        />
      </div>
      {installed ? (
        <span
          className={styles.usage}
          data-band={band}
          title={t(next ? 'prefs.orchestrationRouteNow' : 'prefs.orchestrationRouteUsage', {
            provider,
          })}
        >
          {next ? <i className={styles.nextDot} aria-hidden /> : null}
          {usage === null
            ? null
            : Number.isFinite(usage)
              ? `${Math.round(usage)}%`
              : t('prefs.orchestrationRouteLimited')}
        </span>
      ) : (
        <span
          className={styles.usage}
          data-band="missing"
          title={t('prefs.orchestrationRouteMissingTitle', { provider })}
        >
          {t('prefs.orchestrationRouteMissing')}
        </span>
      )}
      <button
        type="button"
        className={styles.remove}
        onClick={onRemove}
        disabled={!removable}
        title={t('prefs.orchestrationRouteRemove', { position: label })}
        aria-label={t('prefs.orchestrationRouteRemove', { position: label })}
      >
        <X size={13} />
      </button>
    </div>
  )
}

/**
 * The three bands constrain each other, so a value is applied when the person is done typing it,
 * not on every keystroke: a half-typed number would otherwise push its neighbours around.
 */
function PercentInput({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = Math.min(100, Math.max(0, Math.round(parsed)))
    setDraft(String(next))
    onCommit(next)
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={100}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

/** The routing policy, read normalized and written back whole. */
function useRouting() {
  const stored = useProjectsStore((state) => state.preferences.orchestratorPolicy)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const policy = normalizeOrchestratorPolicy(stored)
  const routing = policy.routing
  const save = (next: typeof routing) =>
    setPreferences({
      orchestratorPolicy: normalizeOrchestratorPolicy({
        ...policy,
        routing: normalizeOrchestratorRouting(next),
      }),
    })
  return { routing, save }
}

/** The routing profile and each tier's ordered routes. */
export function OrchestrationRoutingSettings() {
  const t = useT()
  const { routing, save } = useRouting()
  const fitness = useAgentFitness()
  // Unknown until the core answers; a route is only flagged once it is known to be missing.
  const installedAgents = useOrchestratorSnapshot().snapshot.installedAgents
  const selectPreset = (preset: OrchestratorRoutingPreset) => {
    if (preset === 'custom') return
    save({ preset, ...ORCHESTRATOR_ROUTING_PRESETS[preset] })
  }
  const setRoutes = (complexity: OrchestratorTaskComplexity, routes: OrchestratorRoute[]) =>
    save({ ...routing, preset: 'custom', tiers: { ...routing.tiers, [complexity]: routes } })
  // A new route starts as something the tier does not have yet, so the chain gains a real
  // alternative: the other CLI first, then the same CLIs at another effort.
  const addRoute = (complexity: OrchestratorTaskComplexity) => {
    const routes = routing.tiers[complexity]
    const last = routes[routes.length - 1]
    const agents = [...ROUTE_AGENTS].sort(
      (a, b) => Number(a === last.agent) - Number(b === last.agent),
    )
    const efforts: AgentEffortLevel[] = [last.effort ?? 'medium', 'medium', 'high', 'low']
    const taken = (agent: OrchestratorRoute['agent'], effort: AgentEffortLevel) =>
      routes.some((route) => route.agent === agent && !route.model && route.effort === effort)
    const fresh = efforts
      .flatMap((effort) => agents.map((agent) => ({ agent, effort })))
      .find((candidate) => !taken(candidate.agent, candidate.effort))
    setRoutes(complexity, [
      ...routes,
      { agent: fresh?.agent ?? agents[0], model: '', effort: fresh?.effort ?? efforts[0] },
    ])
  }

  return (
    <div className={prefs.optionList}>
      <div className={prefs.optionRow}>
        <span className={prefs.optionCopy}>
          <strong>{t('prefs.orchestrationRoutingPreset')}</strong>
          <span>{t('prefs.orchestrationRoutingPresetDesc')}</span>
        </span>
        <div className={prefs.rowControl}>
          <Dropdown
            value={routing.preset}
            options={(
              [
                'economy',
                'balanced',
                'quality',
                ...(routing.preset === 'custom' ? (['custom'] as const) : []),
              ] as const
            ).map((preset) => ({
              value: preset,
              label: t(`prefs.orchestrationRoutingPreset.${preset}` as MessageKey),
            }))}
            onChange={(value) => selectPreset(value as OrchestratorRoutingPreset)}
            ariaLabel={t('prefs.orchestrationRoutingPreset')}
          />
        </div>
      </div>

      {COMPLEXITIES.map((complexity) => {
        const routes = routing.tiers[complexity]
        const candidates = routes.map((route) => ({
          installed: !installedAgents || installedAgents.includes(route.agent),
          pressure: routePressure(fitness[route.agent], route),
        }))
        const next = pickRoute(candidates, routing)
        return (
          <section key={complexity} className={styles.tier}>
            <span className={prefs.optionCopy}>
              <strong>{t(`prefs.orchestrationTier.${complexity}` as MessageKey)}</strong>
              <span>{t(`prefs.orchestrationTier.${complexity}Desc` as MessageKey)}</span>
            </span>
            <SortableList
              className={styles.routes}
              items={routes}
              // Routes carry no identity of their own; their place in the list is what they are.
              getId={(_, index) => `${complexity}-${index}`}
              onReorder={(from, to) => setRoutes(complexity, moveItem(routes, from, to))}
              renderItem={(route, index, drag) => (
                <RouteEditor
                  route={route}
                  position={index + 1}
                  drag={drag}
                  removable={routes.length > 1}
                  usage={candidates[index].pressure}
                  installed={candidates[index].installed}
                  next={next === index}
                  bands={routing}
                  onChange={(next) =>
                    setRoutes(
                      complexity,
                      routes.map((current, at) => (at === index ? next : current)),
                    )
                  }
                  onRemove={() =>
                    setRoutes(
                      complexity,
                      routes.filter((_, at) => at !== index),
                    )
                  }
                />
              )}
            />
            {routes.length < ORCHESTRATOR_MAX_ROUTES ? (
              <button
                type="button"
                className={styles.addRoute}
                onClick={() => addRoute(complexity)}
              >
                <Plus size={12} />
                {t('prefs.orchestrationRouteAdd')}
              </button>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/** How used a provider may be before its routes are passed over, for every tier at once. */
export function OrchestrationUsageLimits() {
  const t = useT()
  const { routing, save } = useRouting()
  const updatePercent = (key: (typeof LIMITS)[number], value: number) => {
    if (value === routing[key]) return
    save({ ...routing, preset: 'custom', [key]: value })
  }

  return (
    <div className={prefs.optionList}>
      {LIMITS.map((key) => (
        <label key={key} className={prefs.optionRow}>
          <span className={prefs.optionCopy}>
            <strong>{t(`prefs.orchestrationRouting.${key}` as MessageKey)}</strong>
            <span>{t(`prefs.orchestrationRouting.${key}Desc` as MessageKey)}</span>
          </span>
          <span className={styles.percent}>
            <PercentInput value={routing[key]} onCommit={(value) => updatePercent(key, value)} />%
          </span>
        </label>
      ))}
    </div>
  )
}

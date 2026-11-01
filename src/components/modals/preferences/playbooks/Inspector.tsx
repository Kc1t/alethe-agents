import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import type { MessageKey } from '../../../../lib/i18n'
import { ROUTES } from '../../../../lib/playbooks/catalog'
import type { FlowGraph, RoleNode } from '../../../../lib/playbooks/graph'
import {
  condText,
  globalRuleLines,
  modelName,
  providerOrderText,
  spareWhy,
  tierLabel,
  usagePresetLabel,
} from '../../../../lib/playbooks/labels'
import {
  isMap,
  profileNow,
  providerLabel,
  quotaNow,
  type Spare,
  spareOf,
  usageKey,
  workflowNow,
} from '../../../../lib/playbooks/state'
import { usePlaybooks } from './context'
import { DocNodePanel, EdgePanel, PlaybookManager, Problems } from './DocPanels'
import { Hint, PanelHead, Section } from './fields'
import { GlobalRulesEditor, ProviderPanel, RoutePanel, TiersTable } from './GlobalEditors'
import styles from './Playbooks.module.css'
import { RoutingRoleEditor, RoutingRulesEditor } from './RoutingEditors'

const ROUTING_NAMES: Record<string, [MessageKey, MessageKey]> = {
  economy: ['prefs.routingPresetEconomy', 'prefs.routingPresetEconomyDesc'],
  balanced: ['prefs.routingPresetBalanced', 'prefs.routingPresetBalancedDesc'],
  performance: ['prefs.routingPresetPerformance', 'prefs.routingPresetPerformanceDesc'],
}

export function routingName(t: ReturnType<typeof usePlaybooks>['t'], key: string) {
  return ROUTING_NAMES[key] ? t(ROUTING_NAMES[key][0]) : key
}

const TASK_KEYS: Record<string, MessageKey> = {
  all: 'playbooks.task.all',
  narrow: 'playbooks.task.narrow',
  research: 'playbooks.task.research',
  light: 'playbooks.task.light',
  code: 'playbooks.task.code',
  deep: 'playbooks.task.deep',
  review: 'playbooks.task.review',
}

export const CHECK_KEYS: Record<string, MessageKey> = {
  pass: 'playbooks.checks.pass',
  fail: 'playbooks.checks.fail',
  twice: 'playbooks.checks.twice',
}

export const taskLabel = (t: ReturnType<typeof usePlaybooks>['t'], task: string) =>
  t(TASK_KEYS[task])

const ALL_LOW_TRACE: Record<string, MessageKey> = {
  ask: 'playbooks.traceAllLow.ask',
  'run-cheapest': 'playbooks.traceAllLow.runCheapest',
  block: 'playbooks.traceAllLow.block',
}

function ProfileSection() {
  const { s, t } = usePlaybooks()
  const profile = profileNow(s)
  const changed = Object.values(profile.tiers ?? {}).reduce(
    (count, byProvider) => count + Object.keys(byProvider).length,
    0,
  )
  return (
    <Section title={t('playbooks.profileTitle', { profile: profile.name ?? s.profile })}>
      {profile.summary ? <Hint>{profile.summary}</Hint> : null}
      <p className={styles.line}>
        {t('playbooks.profileSwitchAt', { percent: quotaNow(s).criticalThreshold })}
      </p>
      {profile.order ? (
        <p className={styles.line}>
          {t('playbooks.profileTries', { order: providerOrderText(s) })}
        </p>
      ) : null}
      {changed ? (
        <p className={styles.line}>{t('playbooks.profileChanged', { count: changed })}</p>
      ) : null}
    </Section>
  )
}

function SetupSection() {
  const { s, t } = usePlaybooks()
  const setup = isMap(s.data.setup) ? s.data.setup : null
  const date = setup && typeof setup.date === 'string' ? setup.date : null
  const notes =
    setup && Array.isArray(setup.notes)
      ? setup.notes.filter((note) => typeof note === 'string')
      : []
  return (
    <Section title={date ? t('playbooks.setupTitleDated', { date }) : t('playbooks.setupTitle')}>
      {setup ? (
        <>
          <Hint>
            {t('playbooks.setupDone', {
              providers: s.providers.length,
              profiles: Object.keys(s.profiles).length,
              date: date ?? '',
            })}
          </Hint>
          {notes.map((note, i) => (
            <p key={i} className={styles.line}>
              {note}
            </p>
          ))}
        </>
      ) : (
        <Hint>{t('playbooks.setupBundled')}</Hint>
      )}
    </Section>
  )
}

function Overview() {
  const { s, t, select } = usePlaybooks()
  const wf = workflowNow(s)
  const source = wf.kind === 'playbook' && typeof wf.pb.source === 'string' ? wf.pb.source : null
  return (
    <>
      {wf.kind === 'playbook' ? (
        <>
          <PanelHead kind={t('playbooks.kindPlaybook')} title={wf.pb.name} />
          <Problems wf={wf} />
          {wf.pb.goal ? <Hint>{wf.pb.goal}</Hint> : null}
          {source && /^https:\/\//.test(source) ? (
            <p className={styles.hint}>
              <a className={styles.link} href={source} target="_blank" rel="noreferrer">
                {t('playbooks.source')}
              </a>
            </p>
          ) : null}
        </>
      ) : (
        <>
          <PanelHead kind={t('playbooks.kindTaskRouting')} title={routingName(t, wf.key)} />
          <Hint>
            {ROUTING_NAMES[wf.key] ? t(ROUTING_NAMES[wf.key][1]) : ''}{' '}
            {t('playbooks.routingSameAsPrefs')}
          </Hint>
        </>
      )}
      <ProfileSection />
      <Section title={t('playbooks.globalRulesTitle')}>
        {globalRuleLines(s, t).map((line) => (
          <p key={line} className={styles.line}>
            {line}
          </p>
        ))}
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => select('rules')}>
            {t('playbooks.editGlobalRules')}
          </button>
        </div>
      </Section>
      <TiersTable />
      {wf.kind === 'playbook' ? <PlaybookManager key={wf.id} wf={wf} /> : null}
    </>
  )
}

function Trace({ graph }: { graph: FlowGraph }) {
  const { s, t } = usePlaybooks()
  const sim = graph.sim
  const roles = graph.nodes.filter((n): n is RoleNode => n.type === 'role' && sim.reached.has(n.id))
  const spares = s.providers
    .map((id) => spareOf(s, id))
    .filter((spare): spare is Spare => spare !== null)
  const scenario = t('playbooks.traceScenario', {
    task: taskLabel(t, s.task),
    usage: usagePresetLabel(t, usageKey(s)),
    checks: t(CHECK_KEYS[s.checks]).toLowerCase(),
  })
  return (
    <Section title={t('playbooks.traceTitle', { scenario })}>
      <div className={styles.trace}>
        {roles.map((n) => {
          const { final, base, chosen, switched, stuck, spent } = n.resolved
          const reasons: ReactNode[] = []
          if (chosen)
            reasons.push(
              <span key="because" className={styles.ok}>
                {t('playbooks.traceBecause', { condition: condText(s, t, chosen.cond) })}
              </span>,
            )
          if (switched)
            reasons.push(
              <span key="switched" className={styles.warn}>
                {t('playbooks.traceSwitched', {
                  from: providerLabel(s, base.provider),
                  to: providerLabel(s, final.provider),
                })}
              </span>,
            )
          if (stuck)
            reasons.push(
              <span key="stuck" className={styles.warn}>
                {t('playbooks.traceStuck')}
              </span>,
            )
          if (spent)
            reasons.push(
              <span key="spent" className={styles.ok}>
                {t('playbooks.traceSpent', {
                  provider: providerLabel(s, spent),
                  tier: tierLabel(t, final.tier),
                })}
              </span>,
            )
          if (final.via)
            reasons.push(
              <span key="via">
                {t('playbooks.throughRoute', { route: ROUTES[final.via]?.label ?? final.via })}
              </span>,
            )
          return (
            <div key={n.id}>
              <b>{n.title}</b>
              {n.lead ? ` ${t('playbooks.traceLead')}` : ''}
              {n.workers > 1 ? ` ×${n.workers}` : ''}
              {` → ${modelName(s, t, final.provider, final.model)} · ${final.effort ?? t('playbooks.default')}`}
              {reasons.map((reason, i) => (
                <span key={i}>
                  {' · '}
                  {reason}
                </span>
              ))}
            </div>
          )
        })}
        {sim.bothLow ? (
          <div className={sim.blocked ? styles.danger : styles.warn}>
            {t(ALL_LOW_TRACE[quotaNow(s).onBothCritical] ?? ALL_LOW_TRACE.ask)}
          </div>
        ) : null}
        {spares.map((spare) => (
          <div key={spare.provider} className={styles.ok}>
            {t('playbooks.traceSpare', {
              provider: providerLabel(s, spare.provider),
              why: spareWhy(t, spare),
              percent: spare.left,
            })}
          </div>
        ))}
        {s.budget === 'low' ? (
          <div className={styles.warn}>{globalRuleLines(s, t).at(-1)}</div>
        ) : null}
      </div>
    </Section>
  )
}

export function Inspector({
  graph,
  onClose,
  onDelete,
}: {
  graph: FlowGraph
  onClose: () => void
  onDelete: () => void
}) {
  const { s, t, selectedId } = usePlaybooks()
  const wf = workflowNow(s)
  const node = selectedId ? graph.byId[selectedId] : null
  const docNode =
    wf.kind === 'playbook' && selectedId
      ? wf.doc?.nodes.find((n) => n.id === selectedId)
      : undefined
  let body: ReactNode
  if (selectedId === 'rules') body = <GlobalRulesEditor />
  else if (wf.kind === 'playbook' && selectedId?.startsWith('edge:'))
    body = <EdgePanel key={selectedId} wf={wf} id={selectedId} onDelete={onDelete} />
  else if (wf.kind === 'playbook' && docNode)
    body = (
      <DocNodePanel
        key={docNode.id}
        wf={wf}
        node={docNode}
        shown={graph.byId[docNode.id]}
        onDelete={onDelete}
      />
    )
  else if (selectedId?.startsWith('provider:')) body = <ProviderPanel id={selectedId.slice(9)} />
  else if (selectedId?.startsWith('route:')) body = <RoutePanel id={selectedId.slice(6)} />
  else if (node?.type === 'role' && node.ref.kind === 'role' && wf.kind === 'routing') {
    const ref = node.ref
    const role = wf.roles.find((r) => r.name === ref.name)
    body = role ? <RoutingRoleEditor wf={wf} role={role} /> : null
  } else if (
    node?.type === 'decision' &&
    node.ref.kind === 'routing-rules' &&
    wf.kind === 'routing'
  )
    body = <RoutingRulesEditor wf={wf} />
  else
    body = (
      <>
        <Overview />
        <Trace graph={graph} />
        <SetupSection />
      </>
    )
  return (
    <aside
      className={styles.panel}
      aria-label={selectedId ? t('playbooks.inspector') : t('playbooks.details')}
    >
      <div className={styles.panelHead}>
        <span className={styles.sideLabel}>
          {selectedId ? t('playbooks.inspector') : t('playbooks.details')}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className={styles.panelBody}>{body}</div>
    </aside>
  )
}

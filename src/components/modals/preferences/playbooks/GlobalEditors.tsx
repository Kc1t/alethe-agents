import { ArrowDown, ArrowUp } from 'lucide-react'

import { EFFORTS, ROUTES, TIER_NAMES } from '../../../../lib/playbooks/catalog'
import {
  allLowOptions,
  budgetLowOptions,
  tierLabel,
  whenLowOptions,
  whenSpareOptions,
  windowLabel,
} from '../../../../lib/playbooks/labels'
import {
  activeOrder,
  daysUntil,
  finalize,
  longWindow,
  modelCost,
  modelsOf,
  profileNow,
  providerLabel,
  quotaNow,
  type QuotaRule,
  routedVia,
  tiersNow,
  type TierUse,
  windowsOf,
} from '../../../../lib/playbooks/state'
import { usePlaybooks } from './context'
import {
  Check,
  Checks,
  Facts,
  Field,
  Hint,
  NumberField,
  PanelHead,
  Row,
  Section,
  Select,
} from './fields'
import styles from './Playbooks.module.css'
import { ProviderMark } from './ProviderMark'

const profileName = (s: ReturnType<typeof usePlaybooks>['s']) => profileNow(s).name ?? s.profile

export function TiersTable() {
  const { s, t, select } = usePlaybooks()
  return (
    <Section title={t('playbooks.tiersTitle', { profile: profileName(s) })}>
      <Hint>{t('playbooks.tiersHint')}</Hint>
      <table className={styles.tiers}>
        <thead>
          <tr>
            <th />
            {TIER_NAMES.map((tier) => (
              <th key={tier}>{tierLabel(t, tier)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {activeOrder(s).map((id) => (
            <tr key={id}>
              <td>
                <button
                  type="button"
                  className={styles.tierProvider}
                  title={t('playbooks.changeProvider', { provider: providerLabel(s, id) })}
                  onClick={() => select(`provider:${id}`)}
                >
                  <ProviderMark id={id} size={12} />
                  {providerLabel(s, id)}
                </button>
              </td>
              {TIER_NAMES.map((tier) => {
                const use = finalize(s, { provider: id, tier, model: null, effort: null })
                return (
                  <td key={tier}>
                    <span className={styles.tierModel}>{use.model ?? t('playbooks.default')}</span>
                    {use.effort ? <span className={styles.tierEffort}>{use.effort}</span> : null}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

export function GlobalRulesEditor() {
  const { s, t, touch, lightTheme } = usePlaybooks()
  const q = quotaNow(s)
  const b = s.budgetRule
  const base = s.profile === 'base'
  const target = (): Partial<QuotaRule> => (base ? s.quota : (profileNow(s).quota ??= {}))
  const setQuota = (key: keyof QuotaRule, value: string | number) => {
    target()[key] = value as never
    touch(true)
  }
  const ending = s.providers.filter((id) => longWindow(s, id))
  return (
    <>
      <PanelHead
        kind={t('playbooks.kindGlobal', { profile: profileName(s) })}
        title={t('playbooks.globalTitle')}
      />
      <Hint>
        {base
          ? t('playbooks.globalHintBase')
          : t('playbooks.globalHintProfile', { profile: profileName(s) })}
      </Hint>
      <Row>
        <Field label={t('playbooks.tokensLowAt')}>
          <NumberField
            value={q.criticalThreshold}
            min={1}
            max={100}
            ariaLabel={t('playbooks.tokensLowAt')}
            onCommit={(value) => setQuota('criticalThreshold', value)}
          />
        </Field>
        <Field label={t('playbooks.budgetLowAt')}>
          <NumberField
            value={b.warnAt}
            min={1}
            max={100}
            ariaLabel={t('playbooks.budgetLowAt')}
            onCommit={(value) => {
              b.warnAt = value
              touch(true)
            }}
          />
        </Field>
      </Row>
      <Field label={t('playbooks.whenProviderLow')}>
        <Select
          value={q.whenLow}
          ariaLabel={t('playbooks.whenProviderLow')}
          options={whenLowOptions(t)}
          onChange={(value) => setQuota('whenLow', value)}
        />
      </Field>
      <Field label={t('playbooks.whenAllLow')}>
        <Select
          value={q.onBothCritical}
          ariaLabel={t('playbooks.whenAllLow')}
          options={allLowOptions(t)}
          onChange={(value) => {
            s.quota.onBothCritical = value
            touch(true)
          }}
        />
      </Field>
      <Field label={t('playbooks.whenSpare')}>
        <Select
          value={q.whenSpare}
          ariaLabel={t('playbooks.whenSpare')}
          options={whenSpareOptions(t)}
          onChange={(value) => setQuota('whenSpare', value)}
        />
      </Field>
      <Row>
        <Field label={t('playbooks.resetWithin')}>
          <NumberField
            value={q.spareWithinHours}
            min={1}
            max={168}
            ariaLabel={t('playbooks.resetWithin')}
            onCommit={(value) => setQuota('spareWithinHours', value)}
          />
        </Field>
        <Field label={t('playbooks.spareFrom')}>
          <NumberField
            value={q.spareMinLeft}
            min={1}
            max={100}
            ariaLabel={t('playbooks.spareFrom')}
            onCommit={(value) => setQuota('spareMinLeft', value)}
          />
        </Field>
      </Row>
      <Section title={t('playbooks.planEnds')}>
        {ending.map((id) => (
          <div key={id} className={styles.planRow}>
            <span className={styles.provider}>
              <ProviderMark id={id} size={12} />
              {providerLabel(s, id)}
            </span>
            <input
              className={styles.input}
              type="date"
              style={{ colorScheme: lightTheme ? 'light' : 'dark' }}
              aria-label={t('playbooks.planEndsFor', { provider: providerLabel(s, id) })}
              value={s.quota.planEnds?.[id] ?? ''}
              onChange={(event) => {
                const next = { ...(s.quota.planEnds ?? {}) }
                if (event.target.value) next[id] = event.target.value
                else delete next[id]
                s.quota.planEnds = next
                if (s.usage[id])
                  s.usage[id].expires = event.target.value ? daysUntil(event.target.value) : null
                touch(true)
              }}
            />
          </div>
        ))}
        <Hint>{t('playbooks.planEndsHint')}</Hint>
      </Section>
      <Field label={t('playbooks.whenBudgetLow')}>
        <Select
          value={b.whenLow}
          ariaLabel={t('playbooks.whenBudgetLow')}
          options={budgetLowOptions(t)}
          onChange={(value) => {
            b.whenLow = value
            touch(true)
          }}
        />
      </Field>
      <TiersTable />
    </>
  )
}

export function ProviderPanel({ id }: { id: string }) {
  const { s, t, touch } = usePlaybooks()
  const def = s.catalog[id]
  if (!def) return null
  const adapters = s.data.adapters as
    Record<string, { command?: string; args?: string[]; checked?: string }> | undefined
  const adapter = adapters?.[id]
  const order = activeOrder(s)
  const position = order.indexOf(id)
  const via = routedVia(s, id)
  const name = profileName(s)
  const shift = (step: number) => {
    const list = s.profile === 'base' ? s.providers : (profileNow(s).order = [...activeOrder(s)])
    const i = list.indexOf(id)
    const to = i + step
    if (i < 0 || to < 0 || to >= list.length) return
    ;[list[i], list[to]] = [list[to], list[i]]
    touch(true)
  }
  const routes = Object.entries(s.routes).filter(
    ([rid]) => def.dialect && ROUTES[rid]?.dialects.includes(def.dialect),
  )
  const tiers = tiersNow(s)
  const models = modelsOf(s, id)
  const write = (tier: string, key: keyof TierUse, value: string) => {
    let holder: Record<string, TierUse>
    if (s.profile === 'base') holder = s.tiers[tier] ??= {}
    else {
      const profile = profileNow(s)
      profile.tiers ??= {}
      holder = profile.tiers[tier] ??= {}
    }
    const entry: TierUse = { ...(tiers[tier]?.[id] ?? {}), ...(holder[id] ?? {}) }
    if (value) entry[key] = value
    else delete entry[key]
    holder[id] = entry
    touch(true)
  }
  return (
    <>
      <PanelHead
        kind={t('playbooks.kindProvider', {
          adapter:
            def.adapter === 'built-in'
              ? t('playbooks.adapterBuiltIn')
              : t('playbooks.adapterCustom'),
        })}
        title={def.label}
        mark={<ProviderMark id={id} size={16} />}
      />
      <Facts
        rows={[
          [
            t('playbooks.factCommand'),
            adapter?.command ? [adapter.command, ...(adapter.args ?? [])].join(' ') : def.cli,
          ],
          [
            t('playbooks.factReadOnly'),
            def.readOnly ? t('playbooks.readOnlyYes') : t('playbooks.readOnlyNo'),
          ],
          [
            t('playbooks.factUsage'),
            def.reader
              ? t('playbooks.usageRead', {
                  windows: windowsOf(s, id)
                    .map((w) => windowLabel(t, w))
                    .join(', '),
                })
              : t('playbooks.usageNotRead'),
          ],
          [
            t('playbooks.factTraffic'),
            via
              ? t('playbooks.throughRoute', { route: ROUTES[via]?.label ?? via })
              : t('playbooks.trafficDirect'),
          ],
          [t('playbooks.factChecked'), adapter?.checked],
        ]}
      />
      <Section title={t('playbooks.orderTitle', { profile: name })}>
        <Hint>{t('playbooks.orderHint', { position: position + 1, total: order.length })}</Hint>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={position <= 0}
            onClick={() => shift(-1)}
          >
            <ArrowUp size={12} />
            {t('playbooks.earlier')}
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={position >= order.length - 1}
            onClick={() => shift(1)}
          >
            <ArrowDown size={12} />
            {t('playbooks.later')}
          </button>
        </div>
      </Section>
      {routes.length ? (
        <Section title={t('playbooks.routeTitle')}>
          <Checks>
            {routes.map(([rid, route]) => (
              <Check
                key={rid}
                label={t('playbooks.throughRoute', { route: ROUTES[rid].label })}
                checked={(route.carries ?? []).includes(id)}
                onChange={(on) => {
                  route.carries = on
                    ? [...new Set([...(route.carries ?? []), id])]
                    : (route.carries ?? []).filter((carried) => carried !== id)
                  touch(true)
                }}
              />
            ))}
          </Checks>
          <Hint>{t('playbooks.routeGatewayHint')}</Hint>
        </Section>
      ) : null}
      <Section title={t('playbooks.tiersTitle', { profile: name })}>
        <Hint>{models.length ? t('playbooks.modelsFound') : t('playbooks.modelsNone')}</Hint>
        <div className={styles.cards}>
          {TIER_NAMES.map((tier) => {
            const current = tiers[tier]?.[id] ?? {}
            return (
              <div key={tier} className={styles.card}>
                <header>
                  <b>{tierLabel(t, tier)}</b>
                </header>
                <Row wideFirst>
                  <Field label={t('playbooks.fieldModel')}>
                    <Select
                      value={current.model ?? ''}
                      ariaLabel={t('playbooks.tierModelFor', { tier: tierLabel(t, tier) })}
                      options={[
                        { value: '', label: t('playbooks.cliDefault') },
                        ...models.map((model) => {
                          const cost = modelCost(s, id, model)
                          return {
                            value: model,
                            label:
                              cost !== null ? t('playbooks.modelCost', { model, cost }) : model,
                          }
                        }),
                        ...(current.model && !models.includes(current.model)
                          ? [{ value: current.model, label: current.model }]
                          : []),
                      ]}
                      onChange={(value) => write(tier, 'model', value)}
                    />
                  </Field>
                  {def.effort ? (
                    <Field label={t('playbooks.fieldEffort')}>
                      <Select
                        value={current.effort ?? ''}
                        ariaLabel={t('playbooks.tierEffortFor', { tier: tierLabel(t, tier) })}
                        options={[
                          { value: '', label: '—' },
                          ...EFFORTS.map((effort) => ({ value: effort, label: effort })),
                        ]}
                        onChange={(value) => write(tier, 'effort', value)}
                      />
                    </Field>
                  ) : null}
                </Row>
              </div>
            )
          })}
        </div>
      </Section>
    </>
  )
}

export function RoutePanel({ id }: { id: string }) {
  const { s, t, touch } = usePlaybooks()
  const route = s.routes[id]
  const def = ROUTES[id]
  if (!route) return null
  const eligible = s.providers.filter((provider) => {
    const dialect = s.catalog[provider]?.dialect
    return Boolean(dialect && def?.dialects.includes(dialect))
  })
  return (
    <>
      <PanelHead
        kind={t('playbooks.kindRoute')}
        title={def?.label ?? id}
        mark={<ProviderMark id={id} size={16} />}
      />
      <Hint>{t('playbooks.routePanelHint')}</Hint>
      <Facts
        rows={[
          [t('playbooks.factPort'), route.port !== undefined ? String(route.port) : null],
          [
            t('playbooks.factStatus'),
            route.running ? t('playbooks.statusRunning') : t('playbooks.statusStopped'),
          ],
          [
            t('playbooks.factCarries'),
            (route.carries ?? []).map((provider) => providerLabel(s, provider)).join(', ') ||
              t('playbooks.carriesNothing'),
          ],
        ]}
      />
      <Checks>
        {eligible.map((provider) => (
          <Check
            key={provider}
            label={providerLabel(s, provider)}
            checked={(route.carries ?? []).includes(provider)}
            onChange={(on) => {
              route.carries = on
                ? [...new Set([...(route.carries ?? []), provider])]
                : (route.carries ?? []).filter((carried) => carried !== provider)
              touch(true)
            }}
          />
        ))}
      </Checks>
    </>
  )
}

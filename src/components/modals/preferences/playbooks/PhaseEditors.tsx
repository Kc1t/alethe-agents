import { Plus, X } from 'lucide-react'

import type { MessageKey } from '../../../../lib/i18n'
import { EFFORTS, RUNNERS, TIER_NAMES } from '../../../../lib/playbooks/catalog'
import type { RoleNode } from '../../../../lib/playbooks/graph'
import { condLabel, modelName, prettyModel, tierLabel } from '../../../../lib/playbooks/labels'
import {
  applyUse,
  type Cond,
  conditionList,
  condList,
  finalize,
  modelsOf,
  nextProvider,
  type Phase,
  phaseBase,
  phaseTitle,
  type PhaseUse,
  providerLabel,
  tierOf,
} from '../../../../lib/playbooks/state'
import { usePlaybooks } from './context'
import {
  Check,
  Checks,
  Facts,
  Field,
  Hint,
  move,
  MoveButtons,
  NumberField,
  PanelHead,
  Row,
  Section,
  Select,
  TextField,
} from './fields'
import styles from './Playbooks.module.css'

export const runnerLabel = (t: ReturnType<typeof usePlaybooks>['t'], runner: string) =>
  RUNNERS.includes(runner) ? t(`prefs.orchestrationSkillStrategy.${runner}` as MessageKey) : runner

export function CondEditor({
  value,
  onChange,
}: {
  value: Cond | undefined
  onChange: (next: Cond | undefined) => void
}) {
  const { s, t } = usePlaybooks()
  const list = condList(value)
  const write = (next: string[]) =>
    onChange(next.length === 0 ? undefined : next.length === 1 ? next[0] : next)
  const known = conditionList(s)
  return (
    <div className={styles.conds}>
      {list.map((token, i) => {
        const options = known.includes(token) ? known : [token, ...known]
        return (
          <span key={i} className={styles.cond}>
            {i ? <span className={styles.and}>{t('playbooks.and')}</span> : null}
            <Select
              value={token}
              ariaLabel={t('playbooks.condition')}
              options={options.map((option) => ({ value: option, label: condLabel(s, t, option) }))}
              onChange={(next) => {
                const updated = [...list]
                updated[i] = next
                write(updated)
              }}
            />
            {list.length > 1 ? (
              <button
                type="button"
                className={styles.iconButton}
                aria-label={t('playbooks.removeCondition')}
                onClick={() => write(list.filter((_, k) => k !== i))}
              >
                <X size={12} />
              </button>
            ) : null}
          </span>
        )
      })}
      <button type="button" className={styles.button} onClick={() => write([...list, 'deep'])}>
        <Plus size={12} />
        {list.length ? t('playbooks.addAnd') : t('playbooks.addCondition')}
      </button>
    </div>
  )
}

function UseEditor({ use, baseProvider }: { use: PhaseUse; baseProvider: string }) {
  const { s, t, touch } = usePlaybooks()
  const provider = use.provider ?? baseProvider
  const keep = { value: '', label: t('playbooks.keep') }
  const models = modelsOf(s, provider)
  const setKey = (key: keyof PhaseUse, value: string) => {
    if (value) use[key] = value
    else delete use[key]
    touch()
  }
  return (
    <>
      <Row>
        <Field label={t('playbooks.fieldTier')}>
          <Select
            value={use.tier ?? ''}
            ariaLabel={t('playbooks.fieldTier')}
            options={[
              keep,
              ...TIER_NAMES.map((tier) => ({ value: tier, label: tierLabel(t, tier) })),
            ]}
            onChange={(value) => setKey('tier', value)}
          />
        </Field>
        <Field label={t('playbooks.fieldProvider')}>
          <Select
            value={use.provider ?? ''}
            ariaLabel={t('playbooks.fieldProvider')}
            options={[
              keep,
              ...s.providers.map((id) => ({ value: id, label: providerLabel(s, id) })),
            ]}
            onChange={(value) => {
              if (value) use.provider = value
              else delete use.provider
              delete use.model
              touch()
            }}
          />
        </Field>
      </Row>
      <Row>
        <Field label={t('playbooks.fieldModel')}>
          <Select
            value={use.model ?? ''}
            ariaLabel={t('playbooks.fieldModel')}
            options={[
              keep,
              ...models.map((model) => ({ value: model, label: prettyModel(model) })),
              ...(use.model && !models.includes(use.model)
                ? [{ value: use.model, label: use.model }]
                : []),
            ]}
            allowCustom
            customLabel={(value) => t('playbooks.customModel', { value: value.trim() })}
            onChange={(value) => {
              if (!/\s/.test(value.trim())) setKey('model', value.trim())
            }}
          />
        </Field>
        <Field label={t('playbooks.fieldEffort')}>
          <Select
            value={use.effort ?? ''}
            ariaLabel={t('playbooks.fieldEffort')}
            options={[keep, ...EFFORTS.map((effort) => ({ value: effort, label: effort }))]}
            onChange={(value) => setKey('effort', value)}
          />
        </Field>
      </Row>
    </>
  )
}

export function PhaseEditor({
  p,
  node,
  allowIf = false,
}: {
  p: Phase
  node: RoleNode | null
  allowIf?: boolean
}) {
  const { s, t, touch } = usePlaybooks()
  const lead = p.who === 'lead'
  const base = phaseBase(s, p)
  const defaults = tierOf(s, base.tier, base.provider)
  const models = modelsOf(s, base.provider)
  const rules = p.rules ?? []
  const cliDefault = t('playbooks.cliDefault')
  return (
    <>
      <PanelHead
        kind={
          lead
            ? t('playbooks.kindRoleLead')
            : t('playbooks.kindRole', { tier: tierLabel(t, p.tier ?? 'standard') })
        }
        title={phaseTitle(p)}
      />
      <Facts
        rows={[
          [t('playbooks.factId'), p.id],
          [t('playbooks.factLimit'), p.limit !== undefined ? String(p.limit) : null],
        ]}
      />
      <Field label={t('playbooks.fieldDoes')}>
        <TextField
          multiline
          allowEmpty
          value={p.does ?? ''}
          ariaLabel={t('playbooks.fieldDoes')}
          onCommit={(value) => {
            if (value) p.does = value
            else delete p.does
            touch()
          }}
        />
      </Field>
      {!lead ? (
        <Field label={t('playbooks.fieldReturns')}>
          <TextField
            allowEmpty
            value={p.returns ?? ''}
            ariaLabel={t('playbooks.fieldReturns')}
            onCommit={(value) => {
              if (value) p.returns = value
              else delete p.returns
              touch()
            }}
          />
        </Field>
      ) : null}
      {allowIf ? (
        <Field label={t('playbooks.factIf')}>
          <CondEditor
            value={p.if}
            onChange={(next) => {
              if (next === undefined) delete p.if
              else p.if = next
              touch()
            }}
          />
        </Field>
      ) : null}
      <Field label={t('playbooks.fieldRole')}>
        <TextField
          value={phaseTitle(p)}
          ariaLabel={t('playbooks.fieldRole')}
          onCommit={(value) => {
            p.role = value
            touch()
          }}
        />
      </Field>
      <Row>
        <Field label={t('playbooks.fieldTier')}>
          <Select
            value={p.tier ?? 'standard'}
            ariaLabel={t('playbooks.fieldTier')}
            options={TIER_NAMES.map((tier) => ({ value: tier, label: tierLabel(t, tier) }))}
            onChange={(value) => {
              p.tier = value
              touch()
            }}
          />
        </Field>
        <Field label={t('playbooks.fieldProvider')}>
          <Select
            value={p.provider ?? 'auto'}
            ariaLabel={t('playbooks.fieldProvider')}
            options={[
              { value: 'auto', label: t('playbooks.providerAuto') },
              ...s.providers.map((id) => ({ value: id, label: providerLabel(s, id) })),
            ]}
            onChange={(value) => {
              if (value === 'auto') delete p.provider
              else p.provider = value
              delete p.model
              touch()
            }}
          />
        </Field>
      </Row>
      <Row>
        <Field label={t('playbooks.fieldModel')}>
          <Select
            value={p.model ?? ''}
            ariaLabel={t('playbooks.fieldModel')}
            options={[
              {
                value: '',
                label: t('playbooks.tierDefault', {
                  value: defaults.model ? prettyModel(defaults.model) : cliDefault,
                }),
              },
              ...models.map((model) => ({ value: model, label: prettyModel(model) })),
              ...(p.model && !models.includes(p.model) ? [{ value: p.model, label: p.model }] : []),
            ]}
            allowCustom
            customLabel={(value) => t('playbooks.customModel', { value: value.trim() })}
            onChange={(value) => {
              const next = value.trim()
              if (/\s/.test(next)) return
              if (next) p.model = next
              else delete p.model
              touch()
            }}
          />
        </Field>
        <Field label={t('playbooks.fieldEffort')}>
          <Select
            value={p.effort ?? ''}
            ariaLabel={t('playbooks.fieldEffort')}
            options={[
              {
                value: '',
                label: t('playbooks.tierDefault', { value: defaults.effort ?? cliDefault }),
              },
              ...EFFORTS.map((effort) => ({ value: effort, label: effort })),
            ]}
            onChange={(value) => {
              if (value) p.effort = value
              else delete p.effort
              touch()
            }}
          />
        </Field>
      </Row>
      {!lead ? (
        <>
          <Row>
            <Field label={t('playbooks.fieldWorkers')}>
              <NumberField
                value={p.workers ?? 1}
                min={1}
                max={16}
                ariaLabel={t('playbooks.fieldWorkers')}
                onCommit={(value) => {
                  if (value === 1) delete p.workers
                  else p.workers = value
                  touch()
                }}
              />
            </Field>
            <Field label={t('playbooks.fieldRunner')}>
              <Select
                value={p.runner ?? 'economy'}
                ariaLabel={t('playbooks.fieldRunner')}
                options={RUNNERS.map((runner) => ({
                  value: runner,
                  label: runnerLabel(t, runner),
                }))}
                onChange={(value) => {
                  p.runner = value
                  touch()
                }}
              />
            </Field>
          </Row>
          <Checks>
            <Check
              label={t('playbooks.readOnly')}
              checked={Boolean(p.readOnly)}
              onChange={(value) => {
                p.readOnly = value
                touch()
              }}
            />
            <Check
              label={t('playbooks.ownWorktree')}
              checked={Boolean(p.isolate)}
              onChange={(value) => {
                if (value) p.isolate = true
                else delete p.isolate
                touch()
              }}
            />
          </Checks>
        </>
      ) : null}
      <Section title={t('playbooks.rulesTitle')}>
        <Hint>
          {t('playbooks.rulesHint')}
          {lead ? '' : ` ${t('playbooks.rulesHintLow')}`}
        </Hint>
        <div className={styles.cards}>
          {rules.map((rule, i) => {
            const use = rule.use ?? {}
            const preview = finalize(s, applyUse(base, use))
            const heading = t('playbooks.ruleHeading', {
              model: modelName(s, t, preview.provider, preview.model),
              effort: preview.effort ?? t('playbooks.default'),
            })
            return (
              <div key={i} className={styles.card}>
                <header>
                  <b>{heading}</b>
                  <MoveButtons
                    index={i}
                    count={rules.length}
                    name={heading}
                    onMove={(to) => {
                      move(rules, i, to)
                      touch()
                    }}
                    onRemove={() => {
                      rules.splice(i, 1)
                      if (!rules.length) delete p.rules
                      touch()
                    }}
                  />
                </header>
                <Field label={t('playbooks.fieldIf')}>
                  <CondEditor
                    value={rule.if}
                    onChange={(next) => {
                      rule.if = next ?? `${base.provider}-low`
                      touch()
                    }}
                  />
                </Field>
                <UseEditor use={(rule.use ??= {})} baseProvider={base.provider} />
              </div>
            )
          })}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              p.rules = [
                ...rules,
                {
                  if: `${base.provider}-low`,
                  use: { provider: nextProvider(s, base.provider, p, null) ?? base.provider },
                },
              ]
              touch()
            }}
          >
            <Plus size={12} />
            {t('playbooks.addCondition')}
          </button>
        </div>
      </Section>
      {lead ? <Hint>{t('playbooks.leadHint')}</Hint> : null}
      {node?.alts.some((alt) => alt.implicit) ? (
        <Hint>
          {t('playbooks.implicitHint', { condition: condLabel(s, t, `${base.provider}-low`) })}
        </Hint>
      ) : null}
    </>
  )
}

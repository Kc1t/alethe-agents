import { Plus } from 'lucide-react'

import {
  EFFORT_CLASSES,
  EFFORTS,
  GATE_WINDOWS,
  KINDS,
  type RoutingRoleDef,
} from '../../../../lib/playbooks/catalog'
import {
  effortClassLabel,
  gateWindowLabel,
  kindLabel,
  modelName,
  prettyModel,
  taskRuleName,
} from '../../../../lib/playbooks/labels'
import {
  builtInProviders,
  canFallBack,
  modelsOf,
  providerLabel,
  type RoutingWorkflow,
} from '../../../../lib/playbooks/state'
import { usePlaybooks } from './context'
import {
  Check,
  Checks,
  Field,
  Hint,
  move,
  MoveButtons,
  NumberField,
  PanelHead,
  Row,
  Section,
  Select,
} from './fields'
import styles from './Playbooks.module.css'

const toggle = (list: string[], value: string, on: boolean) =>
  on ? [...new Set([...list, value])] : list.filter((item) => item !== value)

function useRoleOption() {
  const { s, t } = usePlaybooks()
  return (role: RoutingRoleDef) =>
    t('playbooks.roleOption', {
      name: role.name,
      model: modelName(s, t, role.agent, role.model),
      effort: role.effort ?? t('playbooks.default'),
    })
}

export function RoutingRoleEditor({ wf, role }: { wf: RoutingWorkflow; role: RoutingRoleDef }) {
  const { s, t, touch } = usePlaybooks()
  const roleOption = useRoleOption()
  const users = wf.rules.map((rule, i) => (rule.role === role.name ? i + 1 : null)).filter(Boolean)
  const models = modelsOf(s, role.agent)
  return (
    <>
      <PanelHead kind={t('playbooks.kindRoutingRole')} title={role.name} />
      <Hint>
        {users.length
          ? t('playbooks.roleUsedBy', { rules: users.join(', ') })
          : t('playbooks.roleUnused')}
      </Hint>
      <Row>
        <Field label={t('playbooks.fieldProvider')}>
          <Select
            value={role.agent}
            ariaLabel={t('playbooks.fieldProvider')}
            options={builtInProviders(s).map((id) => ({ value: id, label: providerLabel(s, id) }))}
            onChange={(value) => {
              role.agent = value
              role.model = null
              touch()
            }}
          />
        </Field>
        <Field label={t('playbooks.fieldModel')}>
          <Select
            value={role.model ?? ''}
            ariaLabel={t('playbooks.fieldModel')}
            options={[
              { value: '', label: t('playbooks.cliDefault') },
              ...models.map((model) => ({ value: model, label: prettyModel(model) })),
              ...(role.model && !models.includes(role.model)
                ? [{ value: role.model, label: role.model }]
                : []),
            ]}
            onChange={(value) => {
              role.model = value || null
              touch()
            }}
          />
        </Field>
      </Row>
      <Field label={t('playbooks.fieldEffort')}>
        <Select
          value={role.effort ?? ''}
          ariaLabel={t('playbooks.fieldEffort')}
          options={[
            { value: '', label: t('playbooks.default') },
            ...EFFORTS.map((effort) => ({ value: effort, label: effort })),
          ]}
          onChange={(value) => {
            role.effort = value || null
            touch()
          }}
        />
      </Field>
      <Checks>
        <Check
          label={t('playbooks.readOnly')}
          checked={role.readOnly}
          onChange={(value) => {
            role.readOnly = value
            const fallback = wf.roles.find((other) => other.name === role.fallback)
            if (fallback && !canFallBack(role, fallback)) role.fallback = null
            touch()
          }}
        />
      </Checks>
      <Section title={t('playbooks.whenLowTitle', { provider: providerLabel(s, role.agent) })}>
        <Field label={t('playbooks.runAs')}>
          <Select
            value={role.fallback ?? ''}
            ariaLabel={t('playbooks.runAs')}
            options={[
              { value: '', label: t('playbooks.keepRunning') },
              ...wf.roles
                .filter((other) => other.name !== role.name)
                .map((other) => ({
                  value: other.name,
                  label: roleOption(other),
                  disabled: !canFallBack(role, other),
                })),
            ]}
            onChange={(value) => {
              role.fallback = value || null
              touch()
            }}
          />
        </Field>
        <Hint>{t('playbooks.fallbackHint')}</Hint>
      </Section>
    </>
  )
}

export function RoutingRulesEditor({ wf }: { wf: RoutingWorkflow }) {
  const { s, t, touch } = usePlaybooks()
  const roleOption = useRoleOption()
  return (
    <>
      <PanelHead kind={t('playbooks.kindCondition')} title={t('playbooks.whichRole')} />
      <Hint>{t('playbooks.whichRoleHint')}</Hint>
      <div className={styles.cards}>
        {wf.rules.map((rule, i) => {
          const gate = rule.gates[0]
          const name = `${i + 1}. ${taskRuleName(t, rule)}`
          return (
            <div key={i} className={styles.card}>
              <header>
                <b>{name}</b>
                <MoveButtons
                  index={i}
                  count={wf.rules.length}
                  name={name}
                  onMove={(to) => {
                    move(wf.rules, i, to)
                    touch()
                  }}
                  onRemove={() => {
                    wf.rules.splice(i, 1)
                    touch()
                  }}
                />
              </header>
              <Field label={t('playbooks.fieldKind')}>
                <Checks>
                  {KINDS.map((kind) => (
                    <Check
                      key={kind}
                      label={kindLabel(t, kind)}
                      checked={rule.kinds.includes(kind)}
                      onChange={(on) => {
                        rule.kinds = toggle(rule.kinds, kind, on)
                        touch()
                      }}
                    />
                  ))}
                </Checks>
              </Field>
              <Field label={t('playbooks.fieldEffortClass')}>
                <Checks>
                  {EFFORT_CLASSES.map((effort) => (
                    <Check
                      key={effort}
                      label={effortClassLabel(t, effort)}
                      checked={rule.efforts.includes(effort)}
                      onChange={(on) => {
                        rule.efforts = toggle(rule.efforts, effort, on)
                        touch()
                      }}
                    />
                  ))}
                </Checks>
              </Field>
              <Field label={t('playbooks.fieldRunsAs')}>
                <Select
                  value={rule.role}
                  ariaLabel={t('playbooks.fieldRunsAs')}
                  options={wf.roles.map((role) => ({ value: role.name, label: roleOption(role) }))}
                  onChange={(value) => {
                    rule.role = value
                    touch()
                  }}
                />
              </Field>
              <Checks>
                <Check
                  label={t('playbooks.gateToggle')}
                  checked={Boolean(gate)}
                  onChange={(on) => {
                    rule.gates = on ? [{ agent: 'claude', window: 'opus', below: 50 }] : []
                    touch()
                  }}
                />
              </Checks>
              {gate ? (
                <Row>
                  <Field label={t('playbooks.fieldProvider')}>
                    <Select
                      value={gate.agent}
                      ariaLabel={t('playbooks.fieldProvider')}
                      options={builtInProviders(s).map((id) => ({
                        value: id,
                        label: providerLabel(s, id),
                      }))}
                      onChange={(value) => {
                        gate.agent = value
                        touch()
                      }}
                    />
                  </Field>
                  <Field label={t('playbooks.fieldWindow')}>
                    <Select
                      value={gate.window}
                      ariaLabel={t('playbooks.fieldWindow')}
                      options={GATE_WINDOWS.map((window) => ({
                        value: window,
                        label: gateWindowLabel(t, window),
                      }))}
                      onChange={(value) => {
                        gate.window = value
                        touch()
                      }}
                    />
                  </Field>
                  <Field label={t('playbooks.fieldBelow')}>
                    <NumberField
                      value={gate.below}
                      min={1}
                      max={100}
                      ariaLabel={t('playbooks.fieldBelow')}
                      onCommit={(value) => {
                        gate.below = value
                        touch()
                      }}
                    />
                  </Field>
                </Row>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            wf.rules.splice(Math.max(0, wf.rules.length - 1), 0, {
              kinds: ['code'],
              efforts: [],
              gates: [],
              role: wf.roles[0]?.name ?? '',
            })
            touch()
          }}
        >
          <Plus size={12} />
          {t('playbooks.addRule')}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            let k = 1
            while (wf.roles.some((role) => role.name === `role-${k}`)) k++
            wf.roles.push({
              name: `role-${k}`,
              agent: 'claude',
              model: 'sonnet',
              effort: 'medium',
              readOnly: false,
              fallback: null,
            })
            touch()
          }}
        >
          <Plus size={12} />
          {t('playbooks.addRole')}
        </button>
      </div>
    </>
  )
}

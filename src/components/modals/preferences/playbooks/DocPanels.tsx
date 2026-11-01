import { Copy, Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { MessageKey } from '../../../../lib/i18n'
import type { DocNode, DocPort } from '../../../../lib/playbooks/flowDoc'
import { deletePlaybook, duplicatePlaybook } from '../../../../lib/playbooks/flowView'
import type { FlowNode, RoleNode } from '../../../../lib/playbooks/graph'
import type { Playbook, PlaybookWorkflow } from '../../../../lib/playbooks/state'
import { usePlaybooks } from './context'
import { Field, Hint, PanelHead, Section, TextField } from './fields'
import { CondEditor, PhaseEditor } from './PhaseEditors'
import styles from './Playbooks.module.css'

export function Problems({ wf, node }: { wf: PlaybookWorkflow; node?: string }) {
  const { t, select } = usePlaybooks()
  const problems = (wf.problems ?? []).filter((p) => !node || p.node === node)
  if (!problems.length) return null
  return (
    <div className={styles.problems} role="alert">
      {problems.map((p) => (
        <button key={`${p.node}:${p.code}`} type="button" onClick={() => select(p.node)}>
          {t(`playbooks.problem.${p.code}` as MessageKey)}
        </button>
      ))}
    </div>
  )
}

function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={`${styles.button} ${styles.dangerButton}`}
        onClick={onDelete}
      >
        <Trash2 size={12} />
        {label}
      </button>
    </div>
  )
}

export function DocNodePanel({
  wf,
  node,
  shown,
  onDelete,
}: {
  wf: PlaybookWorkflow
  node: DocNode
  shown: FlowNode | undefined
  onDelete: () => void
}) {
  const { t, touch } = usePlaybooks()
  const incoming = (wf.doc?.edges ?? []).filter((e) => e.to === node.id)
  const fromKind = (port: DocPort) =>
    incoming.some((e) => e.port === port && wf.doc?.nodes.find((n) => n.id === e.from))
  if (node.kind === 'phase' && node.phase)
    return (
      <>
        <Problems wf={wf} node={node.id} />
        <PhaseEditor
          p={node.phase}
          node={shown?.type === 'role' ? (shown as RoleNode) : null}
          allowIf={fromKind('no') || fromKind('fail')}
        />
        <DeleteButton label={t('playbooks.deleteStep')} onDelete={onDelete} />
      </>
    )
  if (node.kind === 'decision')
    return (
      <>
        <PanelHead kind={t('playbooks.kindCondition')} title={t('playbooks.decisionTitle')} />
        <Problems wf={wf} node={node.id} />
        <Hint>{t('playbooks.decisionHint')}</Hint>
        <Field label={t('playbooks.condition')}>
          <CondEditor
            value={node.cond}
            onChange={(next) => {
              node.cond = next
              touch()
            }}
          />
        </Field>
        <DeleteButton label={t('playbooks.deleteDecision')} onDelete={onDelete} />
      </>
    )
  if (node.kind === 'gate')
    return (
      <>
        <PanelHead kind={t('playbooks.kindCondition')} title={t('playbooks.gateTitle')} />
        <Problems wf={wf} node={node.id} />
        <Hint>{t('playbooks.gateHint')}</Hint>
        <Field label={t('playbooks.passesWhen')}>
          <TextField
            multiline
            value={node.check ?? ''}
            ariaLabel={t('playbooks.passesWhen')}
            onCommit={(value) => {
              node.check = value
              touch()
            }}
          />
        </Field>
        <Hint>{t('playbooks.gatePortsHint')}</Hint>
        <DeleteButton label={t('playbooks.deleteCheck')} onDelete={onDelete} />
      </>
    )
  return (
    <>
      <PanelHead
        kind={t('playbooks.kindFlow')}
        title={node.kind === 'start' ? t('playbooks.start') : t('playbooks.result')}
      />
      <Problems wf={wf} node={node.id} />
      <Hint>{node.kind === 'start' ? t('playbooks.startHint') : t('playbooks.endHint')}</Hint>
    </>
  )
}

const PORT_KEYS: Record<DocPort, MessageKey> = {
  out: 'playbooks.port.out',
  yes: 'playbooks.port.yes',
  no: 'playbooks.port.no',
  pass: 'playbooks.port.pass',
  fail: 'playbooks.port.fail',
}

export function EdgePanel({
  wf,
  id,
  onDelete,
}: {
  wf: PlaybookWorkflow
  id: string
  onDelete: () => void
}) {
  const { t } = usePlaybooks()
  const [from, port, to] = id.slice(5).split('|')
  const name = (nodeId: string) => {
    const node = wf.doc?.nodes.find((n) => n.id === nodeId)
    if (!node) return nodeId
    if (node.kind === 'phase') return node.phase?.role || node.phase?.id || nodeId
    if (node.kind === 'start') return t('playbooks.start')
    if (node.kind === 'end') return t('playbooks.result')
    return node.kind === 'gate' ? t('playbooks.block.check') : t('playbooks.decisionTitle')
  }
  return (
    <>
      <PanelHead kind={t('playbooks.kindConnection')} title={`${name(from)} → ${name(to)}`} />
      <Hint>{t(PORT_KEYS[port as DocPort] ?? 'playbooks.port.out')}</Hint>
      <DeleteButton label={t('playbooks.deleteConnection')} onDelete={onDelete} />
    </>
  )
}

const PLAYBOOK_TEXT: Array<[keyof Playbook, MessageKey, boolean]> = [
  ['name', 'playbooks.fieldName', false],
  ['goal', 'playbooks.fieldGoal', true],
  ['pickWhen', 'playbooks.factPickWhen', true],
  ['saves', 'playbooks.factSaves', true],
  ['avoidWhen', 'playbooks.factAvoidWhen', true],
  ['next', 'playbooks.factThen', true],
]

export function PlaybookManager({ wf }: { wf: PlaybookWorkflow }) {
  const { s, t, touch, select } = usePlaybooks()
  const [confirming, setConfirming] = useState(false)
  return (
    <Section title={t('playbooks.manageTitle')}>
      {PLAYBOOK_TEXT.map(([key, label, optional]) => (
        <Field key={key} label={t(label)}>
          <TextField
            multiline={key !== 'name' && key !== 'next'}
            allowEmpty={optional}
            value={typeof wf.pb[key] === 'string' ? (wf.pb[key] as string) : ''}
            ariaLabel={t(label)}
            onCommit={(value) => {
              if (value) wf.pb[key] = value as never
              else delete wf.pb[key]
              touch()
            }}
          />
        </Field>
      ))}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            const copy = duplicatePlaybook(s, wf, t('playbooks.copyName', { name: wf.pb.name }))
            s.wf = copy.id
            select(null)
            touch(true)
          }}
        >
          <Copy size={12} />
          {t('playbooks.duplicate')}
        </button>
        {confirming ? (
          <button
            type="button"
            className={`${styles.button} ${styles.dangerButton}`}
            onClick={() => {
              deletePlaybook(s, wf)
              select(null)
              touch(true)
            }}
          >
            <Trash2 size={12} />
            {t('playbooks.deleteConfirm', { name: wf.pb.name })}
          </button>
        ) : (
          <button type="button" className={styles.button} onClick={() => setConfirming(true)}>
            <Trash2 size={12} />
            {t('playbooks.deletePlaybook')}
          </button>
        )}
      </div>
    </Section>
  )
}

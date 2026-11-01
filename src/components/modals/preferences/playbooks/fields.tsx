import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Dropdown, type DropdownOption } from '../../../ui/Dropdown'
import { usePlaybooks } from './context'
import styles from './Playbooks.module.css'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span>{label}</span>
      {children}
    </div>
  )
}

export function Row({ children, wideFirst }: { children: ReactNode; wideFirst?: boolean }) {
  return (
    <div className={wideFirst ? `${styles.row} ${styles.rowWideFirst}` : styles.row}>
      {children}
    </div>
  )
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  allowCustom,
  customLabel,
  className,
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  allowCustom?: boolean
  customLabel?: (value: string) => ReactNode
  className?: string
}) {
  return (
    <Dropdown
      value={value}
      options={options}
      onChange={(next) => {
        if (next !== value) onChange(next)
      }}
      ariaLabel={ariaLabel}
      disabled={disabled}
      className={`${styles.select} ${className ?? ''}`}
      searchable={allowCustom}
      allowCustomValue={allowCustom}
      customOptionLabel={customLabel}
    />
  )
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={styles.check}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

export function Checks({ children }: { children: ReactNode }) {
  return <div className={styles.checks}>{children}</div>
}

function NumberDraft({
  value,
  min,
  max,
  onCommit,
  ariaLabel,
}: {
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
  ariaLabel: string
}) {
  const [draft, setDraft] = useState(String(value))
  const commit = () => {
    const next = Math.round(Number(draft))
    if (draft.trim() !== '' && next >= min && next <= max) {
      if (next !== value) onCommit(next)
    } else setDraft(String(value))
  }
  return (
    <input
      className={styles.input}
      type="number"
      min={min}
      max={max}
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

export function NumberField(props: {
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
  ariaLabel: string
}) {
  return <NumberDraft key={props.value} {...props} />
}

function TextDraft({
  value,
  onCommit,
  ariaLabel,
  multiline,
  allowEmpty,
}: {
  value: string
  onCommit: (value: string) => void
  ariaLabel: string
  multiline?: boolean
  allowEmpty?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const commit = () => {
    const next = draft.trim()
    if ((next || allowEmpty) && next !== value) onCommit(next)
    else setDraft(value)
  }
  return multiline ? (
    <textarea
      className={`${styles.input} ${styles.textarea}`}
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  ) : (
    <input
      className={styles.input}
      type="text"
      value={draft}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

export function TextField(props: {
  value: string
  onCommit: (value: string) => void
  ariaLabel: string
  multiline?: boolean
  allowEmpty?: boolean
}) {
  return <TextDraft key={props.value} {...props} />
}

export function Facts({ rows }: { rows: Array<[string, ReactNode | null | undefined]> }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '')
  if (!shown.length) return null
  return (
    <dl className={styles.facts}>
      {shown.map(([label, value]) => (
        <div key={label} className={styles.fact}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h4>{title}</h4>
      {children}
    </section>
  )
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>
}

export function PanelHead({
  kind,
  title,
  mark,
}: {
  kind: string
  title: string
  mark?: ReactNode
}) {
  return (
    <>
      <div className={styles.kind}>{kind}</div>
      <h2 className={styles.panelTitle}>
        {mark}
        {title}
      </h2>
    </>
  )
}

export function MoveButtons({
  index,
  count,
  onMove,
  onRemove,
  name,
}: {
  index: number
  count: number
  onMove: (to: number) => void
  onRemove: () => void
  name: string
}) {
  const { t } = usePlaybooks()
  return (
    <span className={styles.mini}>
      <button
        type="button"
        aria-label={t('playbooks.moveUp', { name })}
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
      >
        <ArrowUp size={12} />
      </button>
      <button
        type="button"
        aria-label={t('playbooks.moveDown', { name })}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        <ArrowDown size={12} />
      </button>
      <button type="button" aria-label={t('playbooks.remove', { name })} onClick={onRemove}>
        <X size={12} />
      </button>
    </span>
  )
}

export function move<T>(list: T[], from: number, to: number) {
  if (to < 0 || to >= list.length) return
  ;[list[from], list[to]] = [list[to], list[from]]
}

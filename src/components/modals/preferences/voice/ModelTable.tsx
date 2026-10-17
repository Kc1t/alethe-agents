import { ChevronRight } from 'lucide-react'
import { Fragment, type ReactNode, useId, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import type { MessageKey } from '../../../../lib/i18n/messages/en'
import controls from '../../controls.module.css'
import styles from './ModelTable.module.css'

export type TableColumn =
  'languages' | 'speed' | 'accuracy' | 'size' | 'voices' | 'price' | 'likes' | 'status'

export interface TableRow {
  id: string
  name: string
  recommended?: boolean
  /** Short tag after the name, e.g. the model's source. */
  badge?: string
  cells: Partial<Record<TableColumn, ReactNode>>
  /** Right-most button(s). */
  action?: ReactNode
  /** Rendered in a full-width row below when expanded. */
  details: ReactNode
}

export interface TableSection {
  id: string
  title: string
  hint: string
  rows: TableRow[]
  /** Column names specific to this section, e.g. a voice's "Quality" for accuracy. */
  columnLabels?: Partial<Record<TableColumn, string>>
}

const COLUMN_LABEL: Record<TableColumn, MessageKey> = {
  languages: 'prefs.voiceColLanguages',
  speed: 'prefs.voiceColSpeed',
  accuracy: 'prefs.voiceColAccuracy',
  size: 'prefs.voiceColSize',
  voices: 'prefs.voiceColVoices',
  price: 'prefs.voiceColPrice',
  likes: 'prefs.voiceColLikes',
  status: 'prefs.voiceColStatus',
}

/** Model comparison table: one row group per section, rows expand into a details panel. */
export function ModelTable({
  sections,
  columns,
  filter,
  search,
  empty,
  onExpand,
}: {
  sections: TableSection[]
  columns: TableColumn[]
  filter?: {
    label?: string
    value: string
    options: { value: string; label: string }[]
    onChange: (value: string) => void
  }
  search?: { value: string; onChange: (value: string) => void; placeholder: string }
  /** Shown in a full-width row when there are no sections (loading or nothing to list). */
  empty?: string
  /** Called with a row's id when its details open. */
  onExpand?: (id: string) => void
}) {
  const t = useT()
  const baseId = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const span = columns.length + 2
  // A header names a section's own label only when every listed section uses it.
  const headerLabel = (column: TableColumn) => {
    const own = sections[0]?.columnLabels?.[column]
    return own && sections.every((section) => section.columnLabels?.[column] === own)
      ? own
      : t(COLUMN_LABEL[column])
  }

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className={styles.root}>
      {filter || search ? (
        <div className={styles.toolbar}>
          {filter ? (
            <div className={styles.filter} role="group" aria-label={filter.label}>
              {filter.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.filterOption}
                  aria-pressed={option.value === filter.value}
                  onClick={() => filter.onChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {search ? (
            <input
              className={`${controls.input} ${styles.search}`}
              type="search"
              value={search.value}
              placeholder={search.placeholder}
              aria-label={search.placeholder}
              onChange={(event) => search.onChange(event.target.value)}
            />
          ) : null}
        </div>
      ) : null}
      {/* Explicit roles keep the table semantics when the stacked layout changes `display`. */}
      <table className={styles.table} role="table">
        <thead className={styles.head} role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              {t('prefs.voiceColModel')}
            </th>
            {columns.map((column) => (
              <th key={column} scope="col" role="columnheader">
                {headerLabel(column)}
              </th>
            ))}
            <th scope="col" role="columnheader">
              <span className={styles.srOnly}>{t('prefs.voiceColActions')}</span>
            </th>
          </tr>
        </thead>
        {sections.length === 0 && empty ? (
          <tbody role="rowgroup">
            <tr role="row" className={styles.emptyRow}>
              <td role="cell" colSpan={span}>
                {empty}
              </td>
            </tr>
          </tbody>
        ) : null}
        {sections.map((section, sectionIndex) => (
          <tbody
            key={section.id}
            className={styles.section}
            role="rowgroup"
            aria-label={section.title}
          >
            <tr className={styles.sectionRow} role="row">
              <th colSpan={span} scope="rowgroup" role="rowheader">
                <span className={styles.sectionTitle}>{section.title}</span>
                <span className={styles.sectionHint}>{section.hint}</span>
              </th>
            </tr>
            {section.rows.map((row, rowIndex) => {
              const key = `${section.id}:${row.id}`
              const open = expanded.has(key)
              const panelId = `${baseId}-${sectionIndex}-${rowIndex}`
              return (
                <Fragment key={row.id}>
                  <tr className={styles.row} role="row" data-open={open}>
                    <td className={styles.nameCell} role="cell">
                      <button
                        type="button"
                        className={styles.toggle}
                        aria-expanded={open}
                        aria-controls={open ? panelId : undefined}
                        onClick={() => {
                          if (!open) onExpand?.(row.id)
                          toggle(key)
                        }}
                      >
                        <ChevronRight size={14} aria-hidden="true" className={styles.chevron} />
                        <span className={styles.name}>{row.name}</span>
                      </button>
                      {row.badge ? <span className={styles.badge}>{row.badge}</span> : null}
                      {row.recommended ? (
                        <span className={styles.badge}>{t('prefs.voiceRecommended')}</span>
                      ) : null}
                    </td>
                    {columns.map((column) => (
                      <td
                        key={column}
                        role="cell"
                        className={styles.cell}
                        data-column={column}
                        data-label={section.columnLabels?.[column] ?? t(COLUMN_LABEL[column])}
                      >
                        {row.cells[column] ?? '—'}
                      </td>
                    ))}
                    <td className={styles.action} role="cell">
                      {row.action}
                    </td>
                  </tr>
                  {open ? (
                    <tr id={panelId} className={styles.detailsRow} role="row">
                      <td colSpan={span} role="cell">
                        {row.details}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        ))}
      </table>
    </div>
  )
}

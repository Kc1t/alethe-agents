import { FolderOpen, Monitor, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { pickDirectory } from '../../../lib/dialog'
import { type MessageKey, useT } from '../../../lib/i18n'
import {
  type AccountProjectRow,
  addProjectToThisMachine,
  forgetMachine,
  loadMachinesView,
  type MachinesView,
} from '../../../lib/sync'
import type { ProjectOverrideGroup } from '../../../lib/types'
import styles from '../SyncModal.module.css'

const GROUP_LABEL: Record<ProjectOverrideGroup, MessageKey> = {
  agents: 'sync.machines.group.agents',
  tooling: 'sync.machines.group.tooling',
}

type Props = {
  open: boolean
  refreshKey: number | null
  onNotice: (text: string) => void
  onError: (error: unknown) => void
}

export function MachinesSection({ open, refreshKey, onNotice, onError }: Props) {
  const t = useT()
  const [view, setView] = useState<MachinesView | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [confirmForget, setConfirmForget] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    loadMachinesView().then(
      (next) => alive && setView(next),
      () => alive && setView(null),
    )
    return () => {
      alive = false
    }
  }, [open, refreshKey, reload])

  if (!view) return null

  const selected = view.machines.find((machine) => machine.id === filter) ?? null
  const rows =
    filter === 'all'
      ? view.rows
      : view.rows.filter((row) => row.machines.some((machine) => machine.id === filter))

  const machineLabel = (machine: { name: string; current: boolean }) =>
    machine.current ? t('sync.machines.thisComputer') : machine.name

  const add = async (row: AccountProjectRow, mode: 'found' | 'choose' | 'none') => {
    let path: string | null = null
    if (mode === 'found') path = row.foundPath
    if (mode === 'choose') {
      path = await pickDirectory({ defaultPath: row.missingPath ?? undefined })
      if (!path) return
    }
    addProjectToThisMachine(row, path)
    onNotice(t('sync.machines.added', { name: row.name }))
    setReload((value) => value + 1)
  }

  const forget = async () => {
    if (!selected || selected.current) return
    setConfirmForget(false)
    try {
      await forgetMachine(selected.id)
      onNotice(t('sync.machines.forgotten', { name: selected.name }))
      setFilter('all')
      setReload((value) => value + 1)
    } catch (error) {
      onError(error)
    }
  }

  const rowMeta = (row: AccountProjectRow) => {
    const machine =
      row.machines.find((entry) => entry.id === filter) ??
      row.machines.find((entry) => entry.current)
    return machine?.path ?? null
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionRow}>
        <span className={styles.sectionLabel}>{t('sync.machines.title')}</span>
        <button
          type="button"
          className={filter === 'all' ? styles.chipActive : styles.chip}
          onClick={() => {
            setFilter('all')
            setConfirmForget(false)
          }}
        >
          {t('sync.machines.all')} · {view.rows.length}
        </button>
        {view.machines.map((machine) => (
          <button
            key={machine.id}
            type="button"
            className={filter === machine.id ? styles.chipActive : styles.chip}
            onClick={() => {
              setFilter(machine.id)
              setConfirmForget(false)
            }}
          >
            <Monitor size={11} />
            {machineLabel(machine)} · {machine.projects}
          </button>
        ))}
      </div>

      {!view.synced ? <p className={styles.hint}>{t('sync.machines.notSynced')}</p> : null}

      {rows.length === 0 ? (
        <p className={styles.hint}>{t('sync.machines.empty')}</p>
      ) : (
        <ul className={`${styles.list} ${styles.machineList}`}>
          {rows.map((row) => {
            const meta = rowMeta(row)
            return (
              <li key={row.id} className={styles.listRow}>
                <span
                  className={styles.projectDot}
                  style={row.color ? { background: row.color } : undefined}
                />
                <span className={styles.machineRowMain}>
                  <span className={styles.listMain}>{row.name}</span>
                  <span className={styles.machineTags}>
                    {row.machines.map((machine) => (
                      <span
                        key={machine.id}
                        className={machine.current ? styles.machineTagCurrent : styles.machineTag}
                        title={
                          machine.custom.length
                            ? t('sync.machines.ownSettingsHint', {
                                groups: machine.custom.map((g) => t(GROUP_LABEL[g])).join(', '),
                              })
                            : (machine.path ?? undefined)
                        }
                      >
                        {machineLabel(machine)}
                        {machine.custom.length ? ` · ${t('sync.machines.ownSettings')}` : null}
                      </span>
                    ))}
                  </span>
                </span>
                {row.localId || filter !== 'all' ? (
                  meta ? (
                    <span className={`${styles.listMeta} ${styles.machinePath}`} title={meta}>
                      {meta}
                    </span>
                  ) : null
                ) : null}
                {!row.localId && row.entry ? (
                  <span className={styles.machineActions}>
                    {row.foundPath ? (
                      <button
                        type="button"
                        className={styles.chip}
                        title={t('sync.machines.foundAt', { path: row.foundPath })}
                        onClick={() => void add(row, 'found')}
                      >
                        <Plus size={11} />
                        {t('sync.machines.add')}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={styles.chip}
                          onClick={() => void add(row, 'choose')}
                        >
                          <FolderOpen size={11} />
                          {t('sync.machines.chooseFolder')}
                        </button>
                        <button
                          type="button"
                          className={styles.link}
                          onClick={() => void add(row, 'none')}
                        >
                          {t('sync.machines.addWithoutFolder')}
                        </button>
                      </>
                    )}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {view.synced ? <p className={styles.hint}>{t('sync.machines.asOf')}</p> : null}

      {selected && !selected.current ? (
        confirmForget ? (
          <div className={styles.confirm}>
            <p>{t('sync.machines.confirmForget', { name: selected.name })}</p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.btnGhost}
                onClick={() => setConfirmForget(false)}
              >
                {t('common.cancel')}
              </button>
              <button type="button" className={styles.btnDanger} onClick={() => void forget()}>
                {t('sync.machines.forget')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.linkDanger}
            onClick={() => setConfirmForget(true)}
          >
            {t('sync.machines.forget')}
          </button>
        )
      ) : null}
    </div>
  )
}

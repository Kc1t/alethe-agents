import { useState } from 'react'

import { useT } from '../../lib/i18n'
import { DEFAULT_GRID_ID, gridTerminals, projectGrids } from '../../lib/projectGrids'
import type { Project } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './ProjectGridModal.module.css'

type Context = {
  projectId: string
  gridId?: string
  terminalId?: string
  action: 'create' | 'rename' | 'delete' | 'move'
}

export function ProjectGridModal() {
  const open = useUiStore((state) => state.openModal === 'projectGrid')
  const context = useUiStore((state) => state.modalContext) as Context | null
  const project = useProjectsStore((state) =>
    state.projects.find((item) => item.id === context?.projectId),
  )
  if (!open || !context || !project) return null
  return (
    <GridForm
      key={`${context.action}:${context.projectId}:${context.gridId}:${context.terminalId}`}
      project={project}
      context={context}
    />
  )
}

function GridForm({ project, context }: { project: Project; context: Context }) {
  const t = useT()
  const grid = projectGrids(project).find((item) => item.id === context.gridId)
  const terminal = project.terminals.find((item) => item.id === context.terminalId)
  const targets: { id: string; name: string }[] = [
    ...(terminal?.gridId ? [{ id: DEFAULT_GRID_ID, name: t('term.gridUngrouped') }] : []),
    ...projectGrids(project).filter(
      (item) => item.id !== DEFAULT_GRID_ID && item.id !== terminal?.gridId,
    ),
  ]
  const [name, setName] = useState(grid?.name ?? '')
  const [target, setTarget] = useState(targets[0]?.id ?? DEFAULT_GRID_ID)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const closeModal = useUiStore((state) => state.closeModal)
  const close = () => {
    if (!busy) closeModal()
  }
  const submit = () => {
    const actions = useProjectsStore.getState()
    if (context.action === 'move') {
      if (!terminal || !targets.some((item) => item.id === target)) return
      actions.moveTerminalToGrid(project.id, terminal.id, target)
      closeModal()
      return
    }
    const ok =
      context.action === 'create'
        ? actions.createProjectGrid(project.id, name)
        : grid && actions.renameProjectGrid(project.id, grid.id, name)
    if (!ok) {
      setError(t('projectGrid.invalidName'))
      return
    }
    if (context.action === 'create') useUiStore.getState().setActiveView('workspace')
    closeModal()
  }
  const remove = async (mode: 'move' | 'delete') => {
    if (!grid || grid.id === DEFAULT_GRID_ID || busy) return
    setBusy(true)
    setError('')
    try {
      await useProjectsStore.getState().deleteProjectGrid(project.id, grid.id, mode)
      closeModal()
    } catch {
      setError(t('projectGrid.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }
  const deleting = context.action === 'delete'
  return (
    <Modal
      open
      onClose={close}
      title={t(`projectGrid.${context.action}`)}
      width={540}
      footer={
        <div className={styles.actions}>
          <button type="button" className={controls.btn} disabled={busy} onClick={close}>
            {t('common.cancel')}
          </button>
          {deleting ? (
            <>
              <button
                type="button"
                className={controls.btn}
                disabled={busy}
                onClick={() => void remove('move')}
              >
                {t('projectGrid.keepTerminals')}
              </button>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnDanger}`}
                disabled={busy}
                onClick={() => void remove('delete')}
              >
                {t('projectGrid.deleteTerminals')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={submit}
              disabled={context.action === 'move' && targets.length === 0}
            >
              {t('common.save')}
            </button>
          )}
        </div>
      }
    >
      {deleting ? (
        <p>
          {t('projectGrid.deleteDescription', {
            name: grid?.name ?? '',
            count: grid ? gridTerminals(project, grid.id).length : 0,
          })}
        </p>
      ) : context.action === 'move' ? (
        <label className={controls.field}>
          <span className={controls.label}>{t('projectGrid.destination')}</span>
          <select
            className={controls.input}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {targets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className={controls.field}>
          <span className={controls.label}>{t('projectGrid.name')}</span>
          <input
            className={controls.input}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </Modal>
  )
}

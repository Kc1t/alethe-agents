import { Folder, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import controls from '../../components/modals/controls.module.css'
import { Modal } from '../../components/modals/Modal'
import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { ensureTodoTemplate } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { useTodosStore } from './store'

export function TodoSettingsModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === TODO_SETTINGS_MODAL_ID)
  const closeModal = useUiStore((state) => state.closeModal)
  const savedPath = useTodosStore((state) => state.storagePath)
  const setStoragePath = useTodosStore((state) => state.setStoragePath)
  const resetTodosToDefault = useTodosStore((state) => state.resetTodosToDefault)
  const savedWorkMinutes = useProjectsStore((state) => state.preferences.pomodoroWorkMinutes)
  const savedShortBreakMinutes = useProjectsStore(
    (state) => state.preferences.pomodoroShortBreakMinutes,
  )
  const savedLongBreakMinutes = useProjectsStore(
    (state) => state.preferences.pomodoroLongBreakMinutes,
  )
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [workMinutes, setWorkMinutes] = useState(savedWorkMinutes)
  const [shortBreakMinutes, setShortBreakMinutes] = useState(savedShortBreakMinutes)
  const [longBreakMinutes, setLongBreakMinutes] = useState(savedLongBreakMinutes)

  useEffect(() => {
    if (open) setPath(savedPath)
  }, [open, savedPath])

  useEffect(() => {
    if (!open) return
    setWorkMinutes(savedWorkMinutes)
    setShortBreakMinutes(savedShortBreakMinutes)
    setLongBreakMinutes(savedLongBreakMinutes)
  }, [open, savedWorkMinutes, savedShortBreakMinutes, savedLongBreakMinutes])

  const clampMinutes = (value: number) => Math.min(120, Math.max(1, Math.round(value)))

  const browse = async () => {
    const selected = await pickDirectory({ defaultPath: path || savedPath || undefined })
    if (selected) setPath(selected)
  }

  const save = async () => {
    const finalPath = path.trim()
    setSaving(true)
    try {
      if (finalPath) {
        await ensureTodoTemplate(finalPath)
      }
      setStoragePath(finalPath)
      setPreferences({
        pomodoroWorkMinutes: clampMinutes(workMinutes),
        pomodoroShortBreakMinutes: clampMinutes(shortBreakMinutes),
        pomodoroLongBreakMinutes: clampMinutes(longBreakMinutes),
      })
      closeModal()
    } catch (error) {
      window.alert(t('todo.templateError', { message: String(error) }))
    } finally {
      setSaving(false)
    }
  }

  const resetDefault = () => {
    if (!window.confirm(t('todo.resetDefaultConfirm'))) return
    resetTodosToDefault()
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('todo.settingsTitle')}
      width={520}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void save()}
            disabled={saving}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className={controls.field}>
        <label className={controls.label}>{t('todo.pathLabel')}</label>
        <div className={controls.cwdRow}>
          <input
            className={controls.input}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t('todo.pathPlaceholder')}
          />
          <button
            type="button"
            className={controls.btn}
            onClick={browse}
            title={t('todo.choosePath')}
            aria-label={t('todo.choosePath')}
          >
            <Folder size={14} />
          </button>
          <button
            type="button"
            className={controls.btn}
            onClick={() => setPath('')}
            title={t('todo.clearPath')}
            aria-label={t('todo.clearPath')}
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('pomodoro.settingsWorkMinutes')}</label>
        <input
          type="number"
          min={1}
          max={120}
          className={controls.input}
          value={workMinutes}
          onChange={(event) => setWorkMinutes(Number(event.target.value))}
        />
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('pomodoro.settingsShortBreakMinutes')}</label>
        <input
          type="number"
          min={1}
          max={120}
          className={controls.input}
          value={shortBreakMinutes}
          onChange={(event) => setShortBreakMinutes(Number(event.target.value))}
        />
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('pomodoro.settingsLongBreakMinutes')}</label>
        <input
          type="number"
          min={1}
          max={120}
          className={controls.input}
          value={longBreakMinutes}
          onChange={(event) => setLongBreakMinutes(Number(event.target.value))}
        />
      </div>
      <div className={controls.field}>
        <label className={controls.label}>{t('todo.defaultLabel')}</label>
        <button type="button" className={controls.btn} onClick={resetDefault}>
          {t('todo.resetDefault')}
        </button>
      </div>
    </Modal>
  )
}

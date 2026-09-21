import { Pause, Play, RotateCcw, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { usePomodoroStore } from '../../stores/pomodoroStore'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './TodoSidebar.module.css'

function useRemainingMs(
  status: string,
  endsAt: number | null,
  remainingMsAtPause: number | null,
): number {
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (status !== 'running') return
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [status])
  if (status === 'paused') return remainingMsAtPause ?? 0
  if (status === 'running' && endsAt !== null) return Math.max(0, endsAt - Date.now())
  return 0
}

function formatMs(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function PomodoroWidget() {
  const t = useT()
  const phase = usePomodoroStore((s) => s.phase)
  const status = usePomodoroStore((s) => s.status)
  const endsAt = usePomodoroStore((s) => s.endsAt)
  const remainingMsAtPause = usePomodoroStore((s) => s.remainingMsAtPause)
  const cyclesCompleted = usePomodoroStore((s) => s.cyclesCompleted)
  const focusTodoId = usePomodoroStore((s) => s.focusTodoId)
  const start = usePomodoroStore((s) => s.start)
  const pause = usePomodoroStore((s) => s.pause)
  const resume = usePomodoroStore((s) => s.resume)
  const reset = usePomodoroStore((s) => s.reset)
  const setFocusTodo = usePomodoroStore((s) => s.setFocusTodo)
  const todos = useProjectsStore((state) => state.todos)
  const activeTodos = todos.filter((todo) => !todo.completed)

  const remainingMs = useRemainingMs(status, endsAt, remainingMsAtPause)

  const phaseLabel =
    phase === 'work'
      ? t('pomodoro.phaseWork')
      : phase === 'shortBreak'
        ? t('pomodoro.phaseShortBreak')
        : phase === 'longBreak'
          ? t('pomodoro.phaseLongBreak')
          : t('pomodoro.phaseIdle')

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionToggle} style={{ cursor: 'default' }}>
          <Timer size={13} />
          <span className={styles.sectionName}>{t('pomodoro.title')}</span>
        </span>
        <span className={styles.sectionRule} />
        {cyclesCompleted > 0 ? (
          <span className={styles.sectionCount}>{cyclesCompleted}</span>
        ) : null}
      </div>
      <div className={styles.pomodoroBody}>
        <div className={styles.pomodoroPhaseRow}>
          <span className={styles.pomodoroPhaseLabel} data-phase={phase}>
            {phaseLabel}
          </span>
          <span className={styles.pomodoroCountdown}>{formatMs(remainingMs)}</span>
        </div>
        <div className={styles.pomodoroControls}>
          {status === 'idle' || status === 'finished' ? (
            <button
              type="button"
              className={`${styles.pomodoroButton} ${styles.pomodoroButtonPrimary}`}
              onClick={() => start()}
            >
              <Play size={13} /> {t('pomodoro.start')}
            </button>
          ) : status === 'running' ? (
            <button type="button" className={styles.pomodoroButton} onClick={pause}>
              <Pause size={13} /> {t('pomodoro.pause')}
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.pomodoroButton} ${styles.pomodoroButtonPrimary}`}
              onClick={resume}
            >
              <Play size={13} /> {t('pomodoro.resume')}
            </button>
          )}
          {status !== 'idle' ? (
            <button type="button" className={styles.pomodoroButton} onClick={reset}>
              <RotateCcw size={13} /> {t('pomodoro.reset')}
            </button>
          ) : null}
        </div>
        <label className={styles.pomodoroFocusRow}>
          <span>{t('pomodoro.focusOnLabel')}</span>
          <select
            className={styles.pomodoroFocusSelect}
            value={focusTodoId ?? ''}
            onChange={(event) => setFocusTodo(event.target.value || null)}
            aria-label={t('pomodoro.focusOnLabel')}
          >
            <option value="">{t('pomodoro.focusOnNone')}</option>
            {activeTodos.map((todo) => (
              <option key={todo.id} value={todo.id}>
                {todo.title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}

import { ArrowRight, Check, FolderPlus, Palette } from 'lucide-react'
import type { ReactNode } from 'react'

import { useT } from '../../lib/i18n'
import { SETUP_WALKTHROUGH_STEPS, type SetupWalkthroughStep } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './SetupWalkthrough.module.css'

const ICONS: Record<SetupWalkthroughStep, ReactNode> = {
  project: <FolderPlus size={14} />,
  appearance: <Palette size={14} />,
}

export function SetupWalkthrough() {
  const t = useT()
  const walkthrough = useProjectsStore((s) => s.preferences.setupWalkthrough)
  const hidden = useProjectsStore((s) => s.preferences.setupWalkthroughHidden)
  const hasProject = useProjectsStore((s) => s.projects.length > 0)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const openModal = useUiStore((s) => s.openModal_)

  const isDone = (step: SetupWalkthroughStep) =>
    step === 'project' ? walkthrough.project || hasProject : walkthrough[step]

  const doneCount = SETUP_WALKTHROUGH_STEPS.filter(isDone).length
  const total = SETUP_WALKTHROUGH_STEPS.length

  if (hidden || doneCount === total) return null

  const start = (step: SetupWalkthroughStep) => {
    if (step === 'project') openModal('newProject')
    else openModal('themePicker')
  }

  return (
    <section className={styles.card} aria-label={t('walkthrough.title')}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.title}>{t('walkthrough.title')}</div>
          <div className={styles.progressText}>
            {t('walkthrough.progress', { done: doneCount, total })}
          </div>
        </div>
        <div className={styles.progressTrack} aria-hidden>
          <i style={{ width: `${(doneCount / total) * 100}%` }} />
        </div>
        <button
          type="button"
          className={styles.hide}
          onClick={() => setPreferences({ setupWalkthroughHidden: true })}
        >
          {t('walkthrough.hide')}
        </button>
      </header>

      <ul className={styles.list}>
        {SETUP_WALKTHROUGH_STEPS.map((step) => {
          const done = isDone(step)
          return (
            <li key={step}>
              <button
                type="button"
                className={styles.item}
                data-done={done ? '' : undefined}
                onClick={() => start(step)}
              >
                <span className={styles.box} aria-hidden>
                  {done ? <Check size={10} /> : ICONS[step]}
                </span>
                <span className={styles.itemCopy}>
                  <span className={styles.itemTitle}>{t(`walkthrough.${step}Title`)}</span>
                  <span className={styles.itemDesc}>{t(`walkthrough.${step}Desc`)}</span>
                </span>
                <ArrowRight size={13} className={styles.itemGo} />
              </button>
            </li>
          )
        })}
      </ul>

      <footer className={styles.footer}>{t('walkthrough.footer')}</footer>
    </section>
  )
}

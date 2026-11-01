import { useEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { attachDocs } from '../../../../lib/playbooks/flowView'
import { createPlaybooksState, type PlaybooksState } from '../../../../lib/playbooks/state'
import { orchestratorPlaybooks, type SkillPlaybooks } from '../../../../lib/tauri'
import styles from './Playbooks.module.css'
import { PlaybooksEditor } from './PlaybooksEditor'

type Loaded = { file: SkillPlaybooks; state: PlaybooksState; generation: number }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function PlaybooksPage() {
  const t = useT()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let live = true
    orchestratorPlaybooks()
      .then((file) => {
        if (!live) return
        try {
          const state = createPlaybooksState(file.text)
          attachDocs(state)
          setLoaded({ file, state, generation })
          setError(null)
        } catch (failure) {
          setError(errorText(failure))
        }
      })
      .catch((failure: unknown) => {
        if (live) setError(errorText(failure))
      })
    return () => {
      live = false
    }
  }, [generation])

  const reload = () => setGeneration((value) => value + 1)

  if (error)
    return (
      <div className={styles.status} role="alert">
        <p>{t('playbooks.loadFailed', { error })}</p>
        <button type="button" className={styles.button} onClick={reload}>
          {t('playbooks.retry')}
        </button>
      </div>
    )
  if (!loaded) return <div className={styles.status}>{t('playbooks.loading')}</div>
  return (
    <PlaybooksEditor
      key={loaded.generation}
      file={loaded.file}
      initial={loaded.state}
      onSaved={(file) => setLoaded((current) => (current ? { ...current, file } : current))}
      onDiscard={reload}
    />
  )
}

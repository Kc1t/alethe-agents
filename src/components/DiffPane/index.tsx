import { X } from 'lucide-react'
import { memo, useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { gitDiff } from '../../lib/tauri'
import { type Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './DiffPane.module.css'

export type DiffPaneProps = {
  projectId: string
  terminal: Terminal
}

export const DiffPane = memo(function DiffPane({ projectId, terminal }: DiffPaneProps) {
  const t = useT()
  const [diffText, setDiffText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const pushToast = useUiStore((s) => s.pushToast)
  const closePane = useProjectsStore((s) => s.closePane)

  useEffect(() => {
    let cancelled = false
    const loadDiff = async () => {
      if (!terminal.filePath || !terminal.cwd) return

      setLoading(true)
      setError(null)

      try {
        const diff = await gitDiff(terminal.cwd, terminal.filePath, !!terminal.staged)

        if (diff.length > 2 * 1024 * 1024) {
          throw new Error(t('diff.error.tooLarge'))
        }

        if (!cancelled) {
          setDiffText(diff || t('diff.empty'))
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const raw = err instanceof Error ? err.message : String(err)
          const errMsg = raw.includes('Binary file') ? t('diff.error.binary') : raw
          setError(errMsg)
          pushToast({ title: t('diff.error.generic'), body: errMsg })
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadDiff()

    return () => {
      cancelled = true
    }
  }, [terminal.filePath, terminal.cwd, terminal.staged, pushToast])

  const renderDiffLine = (line: string, index: number) => {
    let className = ''
    if (line.startsWith('+') && !line.startsWith('+++')) {
      className = styles.added
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      className = styles.removed
    } else if (line.startsWith('@@ ')) {
      className = styles.hunk
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      className = styles.headerLine
    }

    return (
      <span key={index} className={className}>
        {line}
        {'\n'}
      </span>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>{terminal.name}</span>
          <span className={styles.path} title={terminal.filePath}>
            {terminal.filePath} {terminal.staged ? t('diff.staged') : t('diff.unstaged')}
          </span>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={() => closePane(projectId, terminal.id)}
          title={t('diff.close')}
        >
          <X size={14} />
        </button>
      </div>
      <div className={styles.content}>
        {loading ? (
          <div className={styles.message}>{t('diff.loading')}</div>
        ) : error ? (
          <div className={styles.message}>{error}</div>
        ) : diffText ? (
          <pre className={styles.diffText}>
            {diffText.split('\n').map((line, i) => renderDiffLine(line, i))}
          </pre>
        ) : null}
      </div>
    </div>
  )
})

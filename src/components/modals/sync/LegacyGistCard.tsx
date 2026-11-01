import { Download, Github, Loader2, LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  githubSyncLogout,
  githubSyncPull,
  type GithubSyncStatus,
  githubSyncStatus,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import styles from '../SyncModal.module.css'
import { formatWhen, syncErrorText } from './syncText'

export function LegacyGistCard({ open }: { open: boolean }) {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const hydrate = useProjectsStore((s) => s.hydrate)
  const [status, setStatus] = useState<GithubSyncStatus | null>(null)
  const [busy, setBusy] = useState<null | 'pull' | 'logout'>(null)
  const [confirmPull, setConfirmPull] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'notice'; text: string } | null>(null)
  const pushToast = useUiStore((s) => s.pushToast)

  const report = (next: { kind: 'error' | 'notice'; text: string }) => {
    setFeedback(next)
    pushToast({ title: next.text, body: '' })
  }

  useEffect(() => {
    if (!open) return
    setConfirmPull(false)
    setFeedback(null)
    githubSyncStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [open])

  if (!status?.connected) return null

  const pull = async () => {
    setConfirmPull(false)
    setBusy('pull')
    setFeedback(null)
    try {
      setStatus(await githubSyncPull())
      await hydrate()
      report({ kind: 'notice', text: t('sync.github.pullDone') })
    } catch (error) {
      report({ kind: 'error', text: syncErrorText(t, error) })
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    setBusy('logout')
    try {
      setStatus(await githubSyncLogout())
    } catch (error) {
      setFeedback({ kind: 'error', text: syncErrorText(t, error) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Github size={18} />
        </span>
        <div className={styles.cardTitleWrap}>
          <h3 className={styles.cardTitle}>{t('sync.legacy.title')}</h3>
          <p className={styles.cardDesc}>{t('sync.legacy.desc')}</p>
        </div>
      </header>

      {confirmPull ? (
        <div className={styles.confirm}>
          <p>{t('sync.github.confirmPull')}</p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.btnGhost} onClick={() => setConfirmPull(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className={styles.btnPrimary} onClick={pull}>
              {t('sync.github.pull')}
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btn}
            disabled={busy !== null}
            onClick={() => setConfirmPull(true)}
          >
            {busy === 'pull' ? (
              <Loader2 size={14} className={styles.spin} />
            ) : (
              <Download size={14} />
            )}
            {busy === 'pull' ? t('sync.github.pulling') : t('sync.github.pull')}
          </button>
        </div>
      )}

      <div className={styles.cardFooter}>
        <span className={styles.hint}>
          {t('sync.github.lastPull', { when: formatWhen(t, language, status.last_pull_ms) })}
        </span>
        <button
          type="button"
          className={styles.linkDanger}
          disabled={busy !== null}
          onClick={disconnect}
        >
          <LogOut size={12} />
          {t('sync.github.disconnect')}
        </button>
      </div>

      {feedback ? (
        <p className={feedback.kind === 'error' ? styles.error : styles.notice}>{feedback.text}</p>
      ) : null}
    </section>
  )
}

import { ExternalLink, GitPullRequest, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { githubPrListMine, type MyPullRequestSummary } from '../../lib/tauri'
import { useTodosStore } from '../../plugins/todos/store'
import styles from './PullRequestsSidebar.module.css'

export function PullRequestsSidebar() {
  const t = useT()
  const todos = useTodosStore((state) => state.todos)
  const createTodoFromPullRequest = useTodosStore((state) => state.createTodoFromPullRequest)
  const [prs, setPrs] = useState<MyPullRequestSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setPrs(await githubPrListMine())
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const isLinked = (pr: MyPullRequestSummary) =>
    todos.some((todo) => todo.prRepo === pr.repo && todo.prNumber === pr.number)

  return (
    <aside className={styles.sidebar} aria-label={t('prs.title')}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <GitPullRequest size={16} />
          <span>{t('prs.title')}</span>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void load()}
          disabled={loading}
          title={t('prs.refresh')}
          aria-label={t('prs.refresh')}
        >
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        </button>
      </header>

      <div className={styles.content}>
        {loading ? (
          <div className={styles.state}>
            <LoaderCircle size={16} className={styles.spin} />
            <span>{t('prs.loading')}</span>
          </div>
        ) : error ? (
          <div className={styles.error}>{error}</div>
        ) : prs.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>
              <GitPullRequest size={20} />
            </div>
            <strong>{t('prs.emptyTitle')}</strong>
            <span>{t('prs.emptyDescription')}</span>
          </div>
        ) : (
          <div className={styles.list}>
            {prs.map((pr) => {
              const linked = isLinked(pr)
              return (
                <article key={`${pr.repo}#${pr.number}`} className={styles.card}>
                  <div className={styles.cardTop}>
                    <span className={styles.repo} title={pr.repo}>
                      {pr.repo}
                    </span>
                    <span className={styles.number}>#{pr.number}</span>
                    {pr.isDraft ? (
                      <span className={styles.draftBadge}>{t('prs.draftBadge')}</span>
                    ) : null}
                  </div>
                  <h3 className={styles.title} title={pr.title}>
                    {pr.title}
                  </h3>
                  <p className={styles.meta}>
                    {pr.author} ·{' '}
                    {t('prs.updatedLabel', { date: new Date(pr.updatedAt).toLocaleDateString() })}
                  </p>
                  <div className={styles.actions}>
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.actionLink}
                      title={t('prs.openInBrowser')}
                      aria-label={t('prs.openInBrowser')}
                    >
                      <ExternalLink size={13} />
                    </a>
                    <button
                      type="button"
                      className={`${styles.actionButton} ${linked ? styles.actionButtonDone : ''}`}
                      disabled={linked}
                      onClick={() => createTodoFromPullRequest(pr)}
                    >
                      {linked ? t('prs.alreadyAdded') : t('prs.sendToTodo')}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}

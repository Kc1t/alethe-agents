import { ExternalLink, GitPullRequest, LoaderCircle, ShieldCheck } from 'lucide-react'

import type { PullRequestSummary } from '../../lib/tauri'
import { useT } from '../../lib/i18n'
import styles from './PullRequestReviewModal.module.css'

type Props = {
  open: boolean
  loading: boolean
  error: string | null
  pullRequests: PullRequestSummary[]
  branchName: string
  onClose: () => void
  onStartReview: (pr: PullRequestSummary) => void
  onMerge: (pr: PullRequestSummary) => void
}

export function PullRequestReviewModal({
  open,
  loading,
  error,
  pullRequests,
  branchName,
  onClose,
  onStartReview,
  onMerge,
}: Props) {
  const t = useT()
  if (!open) return null

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-review-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <GitPullRequest size={18} />
            <div>
              <h2 id="pr-review-title">{t('merge.prModalTitle')}</h2>
              <p>{branchName}</p>
            </div>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={t('merge.prModalClose')}
          >
            ×
          </button>
        </header>

        {loading ? (
          <div className={styles.state}>
            <LoaderCircle className={styles.spin} size={20} /> {t('merge.prModalLoading')}
          </div>
        ) : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {!loading && !error && pullRequests.length === 0 ? (
          <div className={styles.state}>{t('merge.prModalEmpty')}</div>
        ) : null}

        <div className={styles.list}>
          {pullRequests.map((pr) => (
            <article className={styles.card} key={pr.number}>
              <div className={styles.cardTop}>
                <span>#{pr.number}</span>
                <span className={pr.mergeState === 'CLEAN' ? styles.good : styles.warn}>
                  {pr.mergeState}
                </span>
              </div>
              <h3>{pr.title}</h3>
              <p className={styles.meta}>
                {pr.author} · {pr.baseBranch} ← {pr.headBranch}
              </p>
              {pr.body ? (
                <p className={styles.body}>
                  {pr.body.slice(0, 280)}
                  {pr.body.length > 280 ? '…' : ''}
                </p>
              ) : null}
              <div className={styles.actions}>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} /> {t('merge.prModalGithubLink')}
                </a>
                <button type="button" onClick={() => onStartReview(pr)}>
                  <ShieldCheck size={13} /> {t('merge.prModalReviewAction')}
                </button>
                <button
                  type="button"
                  className={styles.merge}
                  onClick={() => onMerge(pr)}
                  disabled={pr.isDraft || pr.mergeState === 'DIRTY'}
                >
                  {t('merge.prModalMergeAction')}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

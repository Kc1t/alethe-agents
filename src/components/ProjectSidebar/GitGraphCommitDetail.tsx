import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  type GitCommitEntry,
  type GitFileChange,
  gitShowCommitFiles,
  gitShowCommitMessage,
} from '../../lib/tauri'
import styles from './GitGraph.module.css'
import { RefBadges, relativeTime } from './GitGraphList'

export type GitGraphCommitDetailProps = {
  repoRoot: string
  /** null enquanto o commit ainda não está disponível na lista já carregada
   *  (ex.: acabou de recarregar) — o componente volta pra lista sozinho. */
  commit: GitCommitEntry | null
  onBack: () => void
}

/** Tela de detalhe do commit — substitui a antiga expansão inline por linha
 *  (que quebrava a altura fixa da linha e as raias simuladas por CSS).
 *  Troca o CONTEÚDO do mesmo painel (sem modal, sem view separada do app):
 *  mensagem COMPLETA do commit (subject + corpo, não só o subject que
 *  `git_log_graph` já trazia) + lista de arquivos alterados. */
export function GitGraphCommitDetail({ repoRoot, commit, onBack }: GitGraphCommitDetailProps) {
  const t = useT()
  const [message, setMessage] = useState<string | null>(null)
  const [files, setFiles] = useState<GitFileChange[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!commit) return
    let cancelled = false
    setMessage(null)
    setFiles(null)
    setError(null)
    Promise.all([gitShowCommitMessage(repoRoot, commit.hash), gitShowCommitFiles(repoRoot, commit.hash)])
      .then(([msg, changedFiles]) => {
        if (cancelled) return
        setMessage(msg)
        setFiles(changedFiles)
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [repoRoot, commit])

  useEffect(() => {
    if (!commit) onBack()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit])

  if (!commit) return null

  return (
    <div className={styles.detail}>
      <button type="button" className={styles.detailBack} onClick={onBack}>
        <ArrowLeft size={13} />
        {t('common.back')}
      </button>

      <div className={styles.detailHeader}>
        <span className={styles.detailHash}>{commit.hash.slice(0, 10)}</span>
        <RefBadges refs={commit.refs} />
      </div>
      <span className={styles.detailMeta}>
        {commit.authorName} · {relativeTime(commit.timestamp, t)}
      </span>

      {error ? <p className={styles.error}>{error}</p> : null}

      <pre className={styles.detailMessage}>{message ?? t('git.graph.detail.loadingMessage')}</pre>

      <strong className={styles.detailFilesTitle}>{t('git.graph.detail.filesTitle')}</strong>
      <div className={styles.detailFiles}>
        {files === null ? (
          <p className={styles.filesLoading}>{t('git.graph.filesLoading')}</p>
        ) : files.length === 0 ? (
          <p className={styles.filesEmpty}>{t('git.graph.filesEmpty')}</p>
        ) : (
          files.map((file) => (
            <div key={file.path} className={styles.fileRow} title={file.path}>
              <span className={styles.fileStatus}>{file.status}</span>
              <span className={styles.fileName}>{file.path}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

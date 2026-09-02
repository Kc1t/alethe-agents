import { ArrowLeft, ChevronDown, ChevronRight, Languages, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { translationHasApiKey, translationTranslate } from '../../lib/api/translation'
import { detectLanguage } from '../../lib/detectLanguage'
import { getLocale, useT } from '../../lib/i18n'
import {
  type DiffSummaryEntry,
  type GitCommitEntry,
  gitShowCommitFileDiff,
  gitShowCommitMessage,
  gitShowCommitStats,
} from '../../lib/tauri'
import { DiffStatBar } from '../ui/DiffStatBar'
import styles from './GitGraph.module.css'
import { RefBadges, relativeTime } from './GitGraphList'

/** Classifies one patch line for coloring. Order matters: `+++`/`---` are file headers, not an
 *  added and a removed line, so they have to be checked before the single-character prefixes. */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return styles.diffLineMeta
  if (line.startsWith('@@')) return styles.diffLineHunk
  if (line.startsWith('+')) return styles.diffLineAdded
  if (line.startsWith('-')) return styles.diffLineRemoved
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\'))
    return styles.diffLineMeta
  return styles.diffLineContext
}

/** The patch for one file, fetched the first time it's expanded and kept afterwards. */
function FileDiff({ repoRoot, hash, path }: { repoRoot: string; hash: string; path: string }) {
  const t = useT()
  const [patch, setPatch] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setPatch(null)
    setFailed(false)
    gitShowCommitFileDiff(repoRoot, hash, path)
      .then((text) => {
        if (!cancelled) setPatch(text)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [repoRoot, hash, path])

  if (failed) return <p className={styles.filesError}>{t('git.graph.detail.diffFailed')}</p>
  if (patch === null)
    return <p className={styles.filesLoading}>{t('git.graph.detail.diffLoading')}</p>
  const lines = patch.replace(/\n$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '')
    return <p className={styles.filesEmpty}>{t('git.graph.detail.diffEmpty')}</p>

  return (
    <pre className={styles.diffPatch}>
      {lines.map((line, index) => (
        <span key={index} className={`${styles.diffLine} ${diffLineClass(line)}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

/**
 * Offers to translate a commit message that isn't in the app's language.
 *
 * The detection is local and offline; the translation is not. Since translating sends the message
 * to a third-party service, the button never fires on its own: the first use in a session shows
 * what will happen and waits for a second, deliberate confirmation. Consent is per session and per
 * commit — it is not remembered across restarts, because "I agreed once" is a poor reason to keep
 * shipping repository text off the machine silently.
 */
function TranslateMessage({ message }: { message: string }) {
  const t = useT()
  const locale = getLocale()
  const [available, setAvailable] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [translated, setTranslated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    translationHasApiKey()
      .then((has) => {
        if (!cancelled) setAvailable(has)
      })
      .catch(() => {
        if (!cancelled) setAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setTranslated(null)
    setConfirming(false)
    setFailed(false)
  }, [message])

  const sourceLanguage = detectLanguage(message)
  // `null` means the text carried too little signal to tell — offering to translate then would be
  // guessing, so the button simply doesn't appear.
  if (!available || sourceLanguage === null || sourceLanguage === locale) return null

  const translate = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const result = await translationTranslate(message, locale)
      setTranslated(result.text)
      setConfirming(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (translated !== null) {
    return (
      <div className={styles.translation}>
        <span className={styles.translationLabel}>
          <Languages size={11} />
          {t('git.graph.detail.translatedFrom', { language: sourceLanguage })}
        </span>
        <pre className={styles.detailMessage}>{translated}</pre>
        <button
          type="button"
          className={styles.translateButton}
          onClick={() => setTranslated(null)}
        >
          {t('git.graph.detail.showOriginal')}
        </button>
      </div>
    )
  }

  if (confirming) {
    return (
      <div className={styles.translationNotice}>
        <p className={styles.translationWarning}>{t('git.graph.detail.translateWarning')}</p>
        <div className={styles.translationActions}>
          <button
            type="button"
            className={styles.translateButton}
            disabled={busy}
            onClick={() => void translate()}
          >
            {busy ? <Loader2 size={11} className={styles.spin} /> : <Languages size={11} />}
            {t('git.graph.detail.translateConfirm')}
          </button>
          <button
            type="button"
            className={styles.translateButton}
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            {t('common.cancel')}
          </button>
        </div>
        {failed ? (
          <p className={styles.filesError}>{t('git.graph.detail.translateFailed')}</p>
        ) : null}
      </div>
    )
  }

  return (
    <button type="button" className={styles.translateButton} onClick={() => setConfirming(true)}>
      <Languages size={11} />
      {t('git.graph.detail.translate')}
    </button>
  )
}


export type GitGraphCommitDetailProps = {
  repoRoot: string
  /** null while the commit isn't available yet in the already-loaded list
   *  (e.g. just refreshed) — the component navigates back to the list on its own. */
  commit: GitCommitEntry | null
  onBack: () => void
}

/** Commit detail screen — replaces the old inline per-row expansion
 *  (which broke the row's fixed height and the CSS-simulated lanes).
 *  Swaps the CONTENT of the same panel (no modal, no separate app view):
 *  the FULL commit message (subject + body, not just the subject that
 *  `git_log_graph` already provided) + the list of changed files. */
export function GitGraphCommitDetail({ repoRoot, commit, onBack }: GitGraphCommitDetailProps) {
  const t = useT()
  const [message, setMessage] = useState<string | null>(null)
  const [files, setFiles] = useState<DiffSummaryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** One file open at a time — the panel is narrow, and several patches expanded at once turns the
   *  file list into a wall of diff you have to scroll past to reach the next file. */
  const [expandedPath, setExpandedPath] = useState<string | null>(null)

  useEffect(() => {
    if (!commit) return
    let cancelled = false
    setMessage(null)
    setFiles(null)
    setError(null)
    setExpandedPath(null)
    Promise.all([
      gitShowCommitMessage(repoRoot, commit.hash),
      gitShowCommitStats(repoRoot, commit.hash),
    ])
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

  // Commit-wide totals, skipping binary files (they contribute no line counts). Null when nothing
  // countable changed, so a binary-only commit doesn't advertise a meaningless "+0 −0".
  const totals = files?.reduce(
    (accumulated, file) =>
      file.additions === undefined || file.deletions === undefined
        ? accumulated
        : {
            additions: accumulated.additions + file.additions,
            deletions: accumulated.deletions + file.deletions,
          },
    { additions: 0, deletions: 0 },
  )
  const hasTotals = totals !== undefined && totals.additions + totals.deletions > 0

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
      {message ? <TranslateMessage message={message} /> : null}

      <div className={styles.detailFilesHeader}>
        <strong className={styles.detailFilesTitle}>{t('git.graph.detail.filesTitle')}</strong>
        {hasTotals && totals ? (
          <span className={styles.fileStats}>
            <span className={styles.diffAdded}>+{totals.additions}</span>
            <span className={styles.diffRemoved}>−{totals.deletions}</span>
            <DiffStatBar additions={totals.additions} deletions={totals.deletions} />
          </span>
        ) : null}
      </div>
      <div className={styles.detailFiles}>
        {files === null ? (
          <p className={styles.filesLoading}>{t('git.graph.filesLoading')}</p>
        ) : files.length === 0 ? (
          <p className={styles.filesEmpty}>{t('git.graph.filesEmpty')}</p>
        ) : (
          files.map((file) => {
            const expanded = expandedPath === file.path
            return (
              <div key={file.path}>
                <button
                  type="button"
                  className={`${styles.fileRow} ${expanded ? styles.fileRowExpanded : ''}`}
                  title={file.path}
                  aria-expanded={expanded}
                  onClick={() => setExpandedPath(expanded ? null : file.path)}
                >
                  <span className={styles.fileChevron} aria-hidden="true">
                    {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  </span>
                  <span className={styles.fileStatus}>{file.status}</span>
                  <span className={styles.fileName}>{file.path}</span>
                  {file.additions !== undefined && file.deletions !== undefined ? (
                    <span className={styles.fileStats}>
                      {file.additions > 0 ? (
                        <span className={styles.diffAdded}>+{file.additions}</span>
                      ) : null}
                      {file.deletions > 0 ? (
                        <span className={styles.diffRemoved}>−{file.deletions}</span>
                      ) : null}
                      <DiffStatBar additions={file.additions} deletions={file.deletions} />
                    </span>
                  ) : (
                    <span className={styles.fileStats}>
                      <span className={styles.diffBinary}>{t('git.graph.detail.binaryFile')}</span>
                    </span>
                  )}
                </button>
                {expanded ? (
                  <FileDiff repoRoot={repoRoot} hash={commit.hash} path={file.path} />
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

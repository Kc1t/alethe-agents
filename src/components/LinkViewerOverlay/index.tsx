import { ExternalLink, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'

import { useOnEscape } from '../../hooks/useOnEscape'
import { useT } from '../../lib/i18n'
import { openInBrowser, readTextFile } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { VideoPreview } from '../VideoPreview'

const MarkdownRenderer = lazy(() =>
  import('../MarkdownPane/MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer })),
)
import { isMarkdownFilePath, isVideoFilePath } from '../XTermView/terminalLinks'
import styles from './LinkViewerOverlay.module.css'

export function LinkViewerOverlay() {
  const t = useT()
  const url = useUiStore((s) => s.linkViewerUrl)
  const close = useUiStore((s) => s.closeLinkViewer)
  const dark = useProjectsStore(
    (s) => s.preferences.uiTheme !== 'light' && s.preferences.uiTheme !== 'min-light',
  )
  const [markdown, setMarkdown] = useState<string | null>(null)
  const video = Boolean(url && isVideoFilePath(url))
  const markdownFile = Boolean(url && isMarkdownFilePath(url))

  useOnEscape(
    (e) => {
      e.preventDefault()
      close()
    },
    Boolean(url),
    { capture: true },
  )

  useEffect(() => {
    if (!markdownFile || !url) {
      setMarkdown(null)
      return
    }
    let cancelled = false
    void readTextFile(url)
      .then((content) => {
        if (!cancelled) setMarkdown(content)
      })
      .catch(() => {
        if (!cancelled) setMarkdown(null)
      })
    return () => {
      cancelled = true
    }
  }, [markdownFile, url])

  if (!url) return null

  return (
    <div className={styles.backdrop} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <span className={styles.url} title={url}>
            {url}
          </span>
          <button
            type="button"
            className={styles.headBtn}
            onClick={() => void openInBrowser(url)}
            title={t('xterm.openInBrowser')}
            aria-label={t('xterm.openInBrowser')}
          >
            <ExternalLink size={15} />
          </button>
          <button
            type="button"
            className={styles.headBtn}
            onClick={close}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={15} />
          </button>
        </div>
        <div className={styles.body}>
          {video ? (
            <VideoPreview path={url} className={styles.video} />
          ) : markdownFile && markdown !== null ? (
            <div className={styles.markdown}>
              <Suspense fallback={<span>{t('ui.markdown.loading')}</span>}>
                <MarkdownRenderer content={markdown} dark={dark} />
              </Suspense>
            </div>
          ) : (
            <iframe
              key={url}
              src={url}
              className={styles.frame}
              title={url}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
        <div className={styles.hint}>{t('linkViewer.embedHint')}</div>
      </div>
    </div>
  )
}

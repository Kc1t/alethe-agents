import { FileDown, FileUp, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { pickFile, saveFile } from '../../../lib/dialog'
import { type MessageKey, useT } from '../../../lib/i18n'
import { storeHost } from '../../../lib/sync'
import {
  buildBundle,
  BUNDLE_EXTENSION,
  type BundlePreview,
  parseBundle,
  type PreparedImport,
  prepareImport,
} from '../../../lib/sync/bundle'
import { readTextFile, writeTextFile } from '../../../lib/tauri'
import { notifyMissingProfileTooling } from '../../../lib/toolingNotice'
import styles from '../SyncModal.module.css'
import { syncErrorText } from './syncText'

type Feedback = { kind: 'error' | 'notice'; text: string } | null

const PREVIEW_LINES: { key: keyof BundlePreview; label: MessageKey }[] = [
  { key: 'preferences', label: 'sync.file.preview.preferences' },
  { key: 'plugins', label: 'sync.file.preview.plugins' },
  { key: 'projectsCreated', label: 'sync.file.preview.projectsCreated' },
  { key: 'projectsUpdated', label: 'sync.file.preview.projectsUpdated' },
  { key: 'relocations', label: 'sync.file.preview.relocations' },
  { key: 'tooling', label: 'sync.file.preview.tooling' },
  { key: 'secretsNeeded', label: 'sync.file.preview.secrets' },
]

export function FileCard({ open }: { open: boolean }) {
  const t = useT()
  const [busy, setBusy] = useState<null | 'export' | 'import' | 'apply'>(null)
  const [pending, setPending] = useState<PreparedImport | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)

  useEffect(() => {
    if (!open) return
    setPending(null)
    setFeedback(null)
  }, [open])

  const exportBundle = async () => {
    setFeedback(null)
    const date = new Date().toISOString().slice(0, 10)
    const target = await saveFile({
      title: t('sync.file.export'),
      defaultPath: `alethe-${date}.${BUNDLE_EXTENSION}`,
      filters: [{ name: t('sync.file.filter'), extensions: [BUNDLE_EXTENSION] }],
    })
    if (!target) return
    setBusy('export')
    try {
      await writeTextFile(target, JSON.stringify(await buildBundle(storeHost), null, 2))
      setFeedback({ kind: 'notice', text: t('sync.file.exportDone') })
    } catch (error) {
      setFeedback({ kind: 'error', text: syncErrorText(t, error) })
    } finally {
      setBusy(null)
    }
  }

  const chooseImport = async () => {
    setFeedback(null)
    const source = await pickFile({
      title: t('sync.file.import'),
      filters: [{ name: t('sync.file.filter'), extensions: [BUNDLE_EXTENSION, 'json'] }],
    })
    if (!source) return
    setBusy('import')
    try {
      let raw: unknown
      try {
        raw = JSON.parse(await readTextFile(source))
      } catch {
        throw new Error('invalid_bundle')
      }
      const prepared = await prepareImport(parseBundle(raw), storeHost)
      if (prepared.isEmpty) setFeedback({ kind: 'notice', text: t('sync.file.previewNothing') })
      else setPending(prepared)
    } catch (error) {
      setFeedback({ kind: 'error', text: syncErrorText(t, error) })
    } finally {
      setBusy(null)
    }
  }

  const applyImport = async () => {
    if (!pending) return
    setBusy('apply')
    try {
      await pending.apply()
      if (pending.preview.tooling > 0) void notifyMissingProfileTooling()
      setPending(null)
      setFeedback({ kind: 'notice', text: t('sync.file.imported') })
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
          <FileDown size={18} />
        </span>
        <div className={styles.cardTitleWrap}>
          <h3 className={styles.cardTitle}>{t('sync.file.title')}</h3>
          <p className={styles.cardDesc}>{t('sync.file.desc')}</p>
        </div>
      </header>

      {pending ? (
        <div className={styles.confirm}>
          <p>{t('sync.file.previewTitle')}</p>
          <ul className={styles.previewList}>
            {PREVIEW_LINES.filter(({ key }) => pending.preview[key] > 0).map(({ key, label }) => (
              <li key={key}>{t(label, { count: pending.preview[key] })}</li>
            ))}
          </ul>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.btnGhost} onClick={() => setPending(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy !== null}
              onClick={applyImport}
            >
              {busy === 'apply' ? <Loader2 size={14} className={styles.spin} /> : null}
              {t('sync.file.apply')}
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btn}
            disabled={busy !== null}
            onClick={exportBundle}
          >
            {busy === 'export' ? (
              <Loader2 size={14} className={styles.spin} />
            ) : (
              <FileDown size={14} />
            )}
            {t('sync.file.export')}
          </button>
          <button
            type="button"
            className={styles.btn}
            disabled={busy !== null}
            onClick={chooseImport}
          >
            {busy === 'import' ? (
              <Loader2 size={14} className={styles.spin} />
            ) : (
              <FileUp size={14} />
            )}
            {t('sync.file.import')}
          </button>
        </div>
      )}

      {feedback ? (
        <p className={feedback.kind === 'error' ? styles.error : styles.notice}>{feedback.text}</p>
      ) : null}
    </section>
  )
}

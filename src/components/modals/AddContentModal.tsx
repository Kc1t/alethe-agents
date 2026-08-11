import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { FileText, Globe2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { normalizeBrowserUrl } from '../../lib/browserUrl'
import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './AddContentModal.module.css'

type AddKind = 'readme' | 'web' | null

export function AddContentModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'addContent')
  const context = useUiStore((state) => state.modalContext) as { projectId?: string } | null
  const closeModal = useUiStore((state) => state.closeModal)
  const projectId = useProjectsStore((state) => {
    const requested = context?.projectId
    if (requested && state.projects.some((project) => project.id === requested)) return requested
    return state.activeProjectId
  })
  const createFilePane = useProjectsStore((state) => state.createFilePane)
  const createWebPane = useProjectsStore((state) => state.createWebPane)
  const browserEnabled = useProjectsStore((state) => state.preferences.enabledFeatures.browser)
  const [kind, setKind] = useState<AddKind>(null)
  const [urlInput, setUrlInput] = useState('')
  const normalizedUrl = normalizeBrowserUrl(urlInput)

  useEffect(() => {
    if (!open) return
    setKind(null)
    setUrlInput('')
  }, [open])

  const chooseReadme = async () => {
    setKind('readme')
    if (!projectId) return
    const selected = await openFileDialog({
      multiple: false,
      title: t('addContent.readmePickerTitle'),
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
    })
    if (typeof selected !== 'string') {
      setKind(null)
      return
    }
    createFilePane(projectId, { filePath: selected })
    useUiStore.getState().setActiveView('workspace')
    closeModal()
  }

  const addWebsite = () => {
    if (!projectId || !normalizedUrl) return
    createWebPane(projectId, { url: normalizedUrl })
    useUiStore.getState().setActiveView('workspace')
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('addContent.title')}
      width={500}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.cancel')}
          </button>
          {kind === 'web' ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={addWebsite}
              disabled={!projectId || !normalizedUrl}
            >
              {t('addContent.addToCanvas')}
            </button>
          ) : null}
        </>
      }
    >
      <p className={styles.description}>{t('addContent.description')}</p>
      <div className={styles.options}>
        {browserEnabled ? (
          <button
            type="button"
            className={`${styles.option} ${kind === 'readme' ? styles.optionActive : ''}`}
            onClick={() => void chooseReadme()}
            disabled={!projectId}
          >
            <span className={styles.optionIcon}>
              <FileText size={20} />
            </span>
            <span>
              <strong>{t('addContent.readme')}</strong>
              <small>{t('addContent.readmeDescription')}</small>
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.option} ${kind === 'web' ? styles.optionActive : ''}`}
          onClick={() => setKind('web')}
          disabled={!projectId}
        >
          <span className={styles.optionIcon}>
            <Globe2 size={20} />
          </span>
          <span>
            <strong>{t('addContent.website')}</strong>
            <small>{t('addContent.websiteDescription')}</small>
          </span>
        </button>
      </div>
      {kind === 'web' ? (
        <div className={controls.field}>
          <label className={controls.label} htmlFor="add-content-url">
            {t('browser.url')}
          </label>
          <input
            id="add-content-url"
            className={controls.input}
            type="url"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addWebsite()
            }}
            placeholder={t('browser.urlPlaceholder')}
            autoFocus
          />
          <span className={controls.hint}>{t('addContent.websiteHint')}</span>
        </div>
      ) : null}
      {!projectId ? <p className={styles.warning}>{t('ui.markdown.noActiveProject')}</p> : null}
    </Modal>
  )
}

import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { FileText, Globe2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './AddContentModal.module.css'
import controls from './controls.module.css'
import { Modal } from './Modal'

type AddKind = 'readme' | null

export function AddContentModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'addContent')
  const context = useUiStore((state) => state.modalContext) as { projectId?: string } | null
  const closeModal = useUiStore((state) => state.closeModal)
  const openModal = useUiStore((state) => state.openModal_)
  const projectId = useProjectsStore((state) => {
    const requested = context?.projectId
    if (requested && state.projects.some((project) => project.id === requested)) return requested
    return state.activeProjectId
  })
  const createFilePane = useProjectsStore((state) => state.createFilePane)
  const browserEnabled = useProjectsStore((state) => state.preferences.enabledFeatures.browser)
  const [kind, setKind] = useState<AddKind>(null)

  useEffect(() => {
    if (!open) return
    setKind(null)
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
        </>
      }
    >
      <p className={styles.description}>{t('addContent.description')}</p>
      <div className={styles.options}>
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
        {browserEnabled ? (
          <button
            type="button"
            className={styles.option}
            onClick={() => projectId && openModal('addBrowser', { projectId })}
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
        ) : null}
      </div>
      {!projectId ? <p className={styles.warning}>{t('ui.markdown.noActiveProject')}</p> : null}
    </Modal>
  )
}

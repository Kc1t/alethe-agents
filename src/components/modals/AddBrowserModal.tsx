import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

import { normalizeBrowserUrl } from '../../lib/browserUrl'
import { useT } from '../../lib/i18n'
import type { BrowserResourceMode } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown } from '../ui/Dropdown'
import styles from './AddBrowserModal.module.css'
import controls from './controls.module.css'
import { Modal } from './Modal'

const BROWSER_ZOOM_OPTIONS = [0.75, 1, 1.25, 1.5]

type BrowserModalContext = {
  projectId?: string
  url?: string
}

export function AddBrowserModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'addBrowser')
  const context = useUiStore((state) => state.modalContext) as BrowserModalContext | null
  const closeModal = useUiStore((state) => state.closeModal)
  const project = useProjectsStore((state) => {
    const requested = context?.projectId
    if (requested) {
      const match = state.projects.find((candidate) => candidate.id === requested)
      if (match) return match
    }
    return state.projects.find((candidate) => candidate.id === state.activeProjectId) ?? null
  })
  const createWebPane = useProjectsStore((state) => state.createWebPane)
  const [urlInput, setUrlInput] = useState('')
  const [name, setName] = useState('')
  const [javascriptEnabled, setJavascriptEnabled] = useState(true)
  const [resourceMode, setResourceMode] = useState<BrowserResourceMode>('app-first')
  const [zoom, setZoom] = useState(1)
  const normalizedUrl = normalizeBrowserUrl(urlInput)

  useEffect(() => {
    if (!open) return
    setUrlInput(context?.url ?? '')
    setName('')
    setJavascriptEnabled(true)
    setResourceMode('app-first')
    setZoom(1)
  }, [context?.url, open])

  const addBrowser = () => {
    if (!project || !normalizedUrl) return
    createWebPane(project.id, {
      url: normalizedUrl,
      name: name.trim() || undefined,
      javascriptEnabled,
      resourceMode,
      zoom,
    })
    useUiStore.getState().setActiveView('workspace')
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('browser.addTitle')}
      width={520}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={addBrowser}
            disabled={!project || !normalizedUrl}
          >
            {t('browser.addToGrid')}
          </button>
        </>
      }
    >
      <div className={styles.privateNotice}>
        <ShieldCheck size={18} aria-hidden />
        <div>
          <strong>{t('browser.privateTitle')}</strong>
          <span>{t('browser.privateDescription')}</span>
        </div>
      </div>

      <div className={controls.field}>
        <label className={controls.label} htmlFor="add-browser-url">
          {t('browser.url')}
        </label>
        <input
          id="add-browser-url"
          className={controls.input}
          type="url"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addBrowser()
          }}
          placeholder={t('browser.urlPlaceholder')}
          autoFocus
        />
        {urlInput && !normalizedUrl ? (
          <span className={styles.error}>{t('browser.invalidUrl')}</span>
        ) : (
          <span className={controls.hint}>{t('browser.urlHint')}</span>
        )}
      </div>

      <div className={controls.field}>
        <label className={controls.label} htmlFor="add-browser-name">
          {t('browser.name')}
        </label>
        <input
          id="add-browser-name"
          className={controls.input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('browser.namePlaceholder')}
        />
      </div>

      <div className={styles.settingsGrid}>
        <div className={controls.field}>
          <label className={controls.label} htmlFor="add-browser-zoom">
            {t('browser.zoom')}
          </label>
          <Dropdown
            id="add-browser-zoom"
            className={controls.input}
            value={String(zoom)}
            onChange={(value) => setZoom(Number(value))}
            ariaLabel={t('browser.zoom')}
            options={BROWSER_ZOOM_OPTIONS.map((value) => ({
              value: String(value),
              label: `${Math.round(value * 100)}%`,
            }))}
          />
        </div>

        <label className={styles.toggleCard}>
          <input
            type="checkbox"
            checked={javascriptEnabled}
            onChange={(event) => setJavascriptEnabled(event.target.checked)}
          />
          <span>
            <strong>{t('browser.javascript')}</strong>
            <small>{t('browser.javascriptDescription')}</small>
          </span>
        </label>
      </div>

      <div className={controls.field}>
        <label className={controls.label} htmlFor="add-browser-resource-mode">
          {t('browser.resourceMode')}
        </label>
        <Dropdown
          id="add-browser-resource-mode"
          className={controls.input}
          value={resourceMode}
          onChange={(value) => setResourceMode(value as BrowserResourceMode)}
          ariaLabel={t('browser.resourceMode')}
          options={[
            { value: 'app-first', label: t('browser.resourceModeAppFirst') },
            { value: 'balanced', label: t('browser.resourceModeBalanced') },
            { value: 'keep-alive', label: t('browser.resourceModeKeepAlive') },
          ]}
        />
        <span className={controls.hint}>
          {t(`browser.resourceModeDescription.${resourceMode}`)}
        </span>
      </div>

      {project ? (
        <p className={styles.destination}>{t('browser.destination', { project: project.name })}</p>
      ) : (
        <p className={styles.error}>{t('ui.markdown.noActiveProject')}</p>
      )}
    </Modal>
  )
}

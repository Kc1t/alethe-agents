import { Check } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { themeDescription, themeLabel, useThemeOptions } from '../../lib/themes'
import type { VisualStyle } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'
import prefs from './PreferencesModal.module.css'

const VISUAL_STYLES: VisualStyle[] = ['normal', 'clean']

export function ThemePickerModal() {
  const t = useT()
  const themeOptions = useThemeOptions()
  const open = useUiStore((s) => s.openModal === 'themePicker')
  const closeModal = useUiStore((s) => s.closeModal)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const terminalTheme = useProjectsStore((s) => s.preferences.terminalTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle)
  const setUiTheme = useProjectsStore((s) => s.setUiTheme)
  const setTerminalTheme = useProjectsStore((s) => s.setTerminalTheme)
  const setPreferences = useProjectsStore((s) => s.setPreferences)

  const done = () => {
    setPreferences({
      setupWalkthrough: {
        ...useProjectsStore.getState().preferences.setupWalkthrough,
        appearance: true,
      },
    })
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('themePicker.title')}
      width={620}
      footer={
        <>
          <span className={controls.hint} style={{ marginRight: 'auto' }}>
            {t('walkthrough.appearanceFooter')}
          </span>
          <button type="button" className={`${controls.btn} ${controls.btnPrimary}`} onClick={done}>
            {t('walkthrough.done')}
          </button>
        </>
      }
    >
      <div className={controls.themeGrid}>
        {themeOptions.map((theme) => {
          const active = uiTheme === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              className={`${controls.themeCard} ${active ? controls.themeCardActive : ''}`}
              onClick={() => setUiTheme(theme.id)}
            >
              <span className={controls.themeSwatches} aria-hidden>
                {theme.colors.map((color) => (
                  <span key={color} style={{ background: color }} />
                ))}
              </span>
              <span className={controls.themeTitleRow}>
                <strong>{themeLabel(t, theme.id)}</strong>
                {active ? <Check size={15} /> : null}
              </span>
              <span className={controls.themeDescription}>{themeDescription(t, theme.id)}</span>
            </button>
          )
        })}
      </div>

      <div className={controls.field} style={{ marginTop: 16 }}>
        <label className={controls.label}>{t('prefs.visualStyle')}</label>
        <div className={prefs.visualStyleGrid}>
          {VISUAL_STYLES.map((style) => {
            const active = (visualStyle ?? 'normal') === style
            const clean = style === 'clean'
            return (
              <button
                key={style}
                type="button"
                className={`${prefs.visualStyleOption} ${active ? prefs.visualStyleActive : ''}`}
                onClick={() => setPreferences({ visualStyle: style })}
                aria-pressed={active}
              >
                <span
                  className={`${prefs.visualStylePreview} ${
                    clean ? prefs.visualStylePreviewClean : prefs.visualStylePreviewNormal
                  }`}
                  aria-hidden
                >
                  <span className={prefs.previewToolbar} />
                  <span className={prefs.previewSidebar}>
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className={prefs.previewWorkspace}>
                    <span />
                    <span />
                  </span>
                </span>
                <span className={prefs.visualStyleCopy}>
                  <strong>{t(clean ? 'prefs.visualStyleClean' : 'prefs.visualStyleNormal')}</strong>
                  <small>
                    {t(clean ? 'prefs.visualStyleCleanDesc' : 'prefs.visualStyleNormalDesc')}
                  </small>
                </span>
                {active ? <Check size={15} /> : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className={controls.field} style={{ marginTop: 16 }}>
        <label className={controls.label}>{t('prefs.terminalTheme')}</label>
        <div className={controls.pillRow}>
          <button
            type="button"
            className={`${controls.pill} ${terminalTheme === null ? controls.pillActive : ''}`}
            onClick={() => setTerminalTheme(null)}
          >
            {t('common.followUi')}
          </button>
          {themeOptions.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`${controls.pill} ${terminalTheme === theme.id ? controls.pillActive : ''}`}
              onClick={() => setTerminalTheme(theme.id)}
            >
              {themeLabel(t, theme.id)}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

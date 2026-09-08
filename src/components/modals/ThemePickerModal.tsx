import { Check } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { THEME_OPTIONS, themeDescription, themeLabel } from '../../lib/themes'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'

export function ThemePickerModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'themePicker')
  const closeModal = useUiStore((s) => s.closeModal)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const terminalTheme = useProjectsStore((s) => s.preferences.terminalTheme)
  const setUiTheme = useProjectsStore((s) => s.setUiTheme)
  const setTerminalTheme = useProjectsStore((s) => s.setTerminalTheme)

  return (
    <Modal open={open} onClose={closeModal} title={t('themePicker.title')} width={620}>
      <div className={controls.themeGrid}>
        {THEME_OPTIONS.map((theme) => {
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
        <label className={controls.label}>{t('prefs.terminalTheme')}</label>
        <div className={controls.pillRow}>
          <button
            type="button"
            className={`${controls.pill} ${terminalTheme === null ? controls.pillActive : ''}`}
            onClick={() => setTerminalTheme(null)}
          >
            {t('common.followUi')}
          </button>
          {THEME_OPTIONS.map((theme) => (
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

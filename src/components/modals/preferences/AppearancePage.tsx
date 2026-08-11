import { Check, Minus, Plus, RotateCcw } from 'lucide-react'

import { useT } from '../../../lib/i18n'
import { THEME_OPTIONS, themeDescription, themeLabel } from '../../../lib/themes'
import type { AppIconTheme } from '../../../lib/types'
import { UI_ZOOM_LIMITS, useProjectsStore } from '../../../stores/projectsStore'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'
import { Dropdown } from '../../ui/Dropdown'

export function AppearancePage() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setUiTheme = useProjectsStore((state) => state.setUiTheme)
  const setTerminalTheme = useProjectsStore((state) => state.setTerminalTheme)
  const setUiZoom = useProjectsStore((state) => state.setUiZoom)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  return (
    <>
      <SettingsSection
        id="ui-theme"
        title={t('prefs.uiTheme')}
        description={t('prefs.uiThemeDesc')}
      >
        <div className={styles.themeGrid}>
          {THEME_OPTIONS.map((theme) => {
            const active = preferences.uiTheme === theme.id
            return (
              <button
                key={theme.id}
                type="button"
                className={active ? styles.themeActive : undefined}
                onClick={() => setUiTheme(theme.id)}
              >
                <span className={styles.swatches} aria-hidden>
                  {theme.colors.map((color) => (
                    <span key={color} style={{ background: color }} />
                  ))}
                </span>
                <span className={styles.themeName}>
                  <strong>{themeLabel(t, theme.id)}</strong>
                  {active ? <Check size={15} /> : null}
                </span>
                <span>{themeDescription(t, theme.id)}</span>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        id="app-icon-theme"
        title="App icon theme"
        description="Choose the native desktop icon independently from the interface theme."
      >
        <Dropdown
          className={styles.select}
          value={preferences.appIconTheme}
          onChange={(value) => setPreferences({ appIconTheme: value as AppIconTheme })}
          ariaLabel="App icon theme"
          options={[
            ...THEME_OPTIONS.map((theme) => ({ value: theme.id, label: themeLabel(t, theme.id) })),
            { value: 'alethe-blue-gradient', label: 'Alethe Blue Gradient' },
            { value: 'alethe-pink-gradient', label: 'Alethe Pink Gradient' },
          ]}
        />
      </SettingsSection>

      <SettingsSection
        id="terminal-theme"
        title={t('prefs.terminalTheme')}
        description={t('prefs.terminalThemeDesc')}
      >
        <Dropdown
          className={styles.select}
          value={preferences.terminalTheme ?? ''}
          onChange={(value) =>
            setTerminalTheme(value ? (value as typeof preferences.uiTheme) : null)
          }
          ariaLabel={t('prefs.terminalTheme')}
          options={[
            { value: '', label: t('common.followUi') },
            ...THEME_OPTIONS.map((theme) => ({ value: theme.id, label: themeLabel(t, theme.id) })),
          ]}
        />
      </SettingsSection>

      <SettingsSection id="ui-zoom" title={t('prefs.uiZoom')} description={t('prefs.uiZoomDesc')}>
        <div className={styles.zoomControl}>
          <button
            type="button"
            onClick={() => setUiZoom(preferences.uiZoom - UI_ZOOM_LIMITS.step)}
            disabled={preferences.uiZoom <= UI_ZOOM_LIMITS.min}
            aria-label={t('prefs.zoomDecrease')}
          >
            <Minus size={15} />
          </button>
          <strong>{Math.round(preferences.uiZoom * 100)}%</strong>
          <button
            type="button"
            onClick={() => setUiZoom(preferences.uiZoom + UI_ZOOM_LIMITS.step)}
            disabled={preferences.uiZoom >= UI_ZOOM_LIMITS.max}
            aria-label={t('prefs.zoomIncrease')}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setUiZoom(1)}
            disabled={preferences.uiZoom === 1}
            aria-label={t('prefs.zoomReset')}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="topbar-style"
        title={t('prefs.topbarStyle')}
        description={t('prefs.topbarStyleDesc')}
      >
        <Dropdown
          value={preferences.topbarStyle}
          onChange={(value) => setPreferences({ topbarStyle: value as 'classic' | 'three-areas' })}
          ariaLabel={t('prefs.topbarStyle')}
          options={[
            { value: 'classic', label: t('prefs.topbarStyleClassic') },
            { value: 'three-areas', label: t('prefs.topbarStyleThreeAreas') },
          ]}
        />
      </SettingsSection>

      <SettingsSection
        id="git-control-placement"
        title={t('prefs.gitControlPlacement')}
        description={t('prefs.gitControlPlacementDesc')}
      >
        <Dropdown
          value={preferences.gitControlPlacement}
          onChange={(value) => setPreferences({ gitControlPlacement: value as 'left' | 'right' })}
          ariaLabel={t('prefs.gitControlPlacement')}
          options={[
            { value: 'left', label: t('prefs.gitControlPlacementLeft') },
            { value: 'right', label: t('prefs.gitControlPlacementRight') },
          ]}
        />
      </SettingsSection>

      <SettingsSection
        id="window-opacity"
        title={t('prefs.windowOpacity')}
        description={t('prefs.windowOpacityDesc')}
      >
        <div className={styles.opacityControl}>
          <input
            type="range"
            min="60"
            max="100"
            step="5"
            value={Math.round(preferences.windowOpacity * 100)}
            onChange={(event) =>
              setPreferences({ windowOpacity: Number(event.target.value) / 100 })
            }
            aria-label={t('prefs.windowOpacity')}
          />
          <strong>{Math.round(preferences.windowOpacity * 100)}%</strong>
          <button
            type="button"
            onClick={() => setPreferences({ windowOpacity: 1 })}
            disabled={preferences.windowOpacity === 1}
            aria-label={t('prefs.opacityReset')}
          >
            <RotateCcw size={15} />
          </button>
        </div>
        <p className={styles.experimentalHint}>{t('prefs.windowOpacityHint')}</p>
      </SettingsSection>
    </>
  )
}

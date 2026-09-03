import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  cliShimInstall,
  type CliShimStatus,
  cliShimStatus,
  cliShimUninstall,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Router9Settings } from '../../Router9/Router9Settings'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

   
                                                                            
                                                                           
                                                       
   
function TerminalCommandSection() {
  const t = useT()
  const [status, setStatus] = useState<CliShimStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void cliShimStatus()
      .then((next) => {
        if (!disposed) setStatus(next)
      })
      .catch(() => {
        if (!disposed) setStatus(null)
      })
    return () => {
      disposed = true
    }
  }, [])

  const run = async (action: () => Promise<CliShimStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="terminal-command"
      title={t('prefs.cliCommand')}
      description={t('prefs.cliCommandDesc')}
    >
      <div className={styles.integrationFields}>
        <pre className={styles.cliUsage}>
          <code>{'alethe\nalethe .\nalethe ~/meu-projeto'}</code>
        </pre>

        {status?.supported === false ? (
          <p>{t('prefs.cliUnsupported')}</p>
        ) : (
          <>
            <div className={styles.cliActions}>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                disabled={busy || !status}
                onClick={() => void run(cliShimInstall)}
              >
                {status?.installed ? t('prefs.cliReinstall') : t('prefs.cliInstall')}
              </button>
              {status?.installed ? (
                <button
                  type="button"
                  className={`${controls.btn} ${controls.btnDanger}`}
                  disabled={busy}
                  onClick={() => void run(cliShimUninstall)}
                >
                  {t('prefs.cliUninstall')}
                </button>
              ) : null}
            </div>

            {status?.installed && status.path ? (
              <p className={styles.cliPath}>{t('prefs.cliInstalledAt', { path: status.path })}</p>
            ) : null}

            {status?.stale ? <p className={styles.cliWarning}>{t('prefs.cliStale')}</p> : null}

            {status?.installed && !status.onPath && status.binDir ? (
              <p className={styles.cliWarning}>{t('prefs.cliNotOnPath', { dir: status.binDir })}</p>
            ) : null}

            {error ? <p className={styles.cliWarning}>{error}</p> : null}
          </>
        )}
      </div>
    </SettingsSection>
  )
}

export function IntegrationsPage() {

  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  return (
    <>
      <TerminalCommandSection />

      <Router9Settings />

      <SettingsSection id="spotify" title={t('prefs.spotify')} description={t('prefs.spotifyDesc')}>
        <div className={styles.integrationFields}>
          <label>
            <span>Client ID</span>
            <input
              className={controls.input}
              value={preferences.spotifyClientId}
              onChange={(event) => setPreferences({ spotifyClientId: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Client Secret</span>
            <input
              className={controls.input}
              type="password"
              value={preferences.spotifyClientSecret}
              onChange={(event) => setPreferences({ spotifyClientSecret: event.target.value })}
              spellCheck={false}
            />
          </label>
          <p>
            {t('prefs.spotifyHint', {
              redirect: 'http://127.0.0.1:8888/callback',
              idEnv: 'SPOTIFY_CLIENT_ID',
              secretEnv: 'SPOTIFY_CLIENT_SECRET',
            })}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        id="discord"
        title={t('prefs.discordPresence')}
        description={t('prefs.discordPresenceHint')}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.discordRichPresenceEnabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ discordRichPresenceEnabled: true })}
          >
            {t('prefs.discordPresenceEnabled')}
          </button>
          <button
            type="button"
            className={!preferences.discordRichPresenceEnabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ discordRichPresenceEnabled: false })}
          >
            {t('prefs.discordPresenceDisabled')}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="dictation"
        title={t('prefs.dictation')}
        description={t('prefs.dictationDesc')}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.dictationEnabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ dictationEnabled: true })}
          >
            {t('prefs.dictationOn')}
          </button>
          <button
            type="button"
            className={!preferences.dictationEnabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ dictationEnabled: false })}
          >
            {t('prefs.dictationOff')}
          </button>
        </div>
        <p>{t('prefs.dictationHandyHint')}</p>
      </SettingsSection>
    </>
  )
}

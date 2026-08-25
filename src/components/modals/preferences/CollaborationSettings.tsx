import { Bell, Clock3, Eye, Loader2, Radio, ShieldCheck, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  type AccessRecord,
  type CollaborationActivationState,
  type CollaborationServiceMode,
  type CollaborationServiceSettings,
  connectRendezvous,
  disableCollaborationService,
  enableCollaborationService,
  getCollaborationServiceSettings,
  resolveCollaborationActivationState,
  setCollaborationServiceMode,
  syncAccessList,
  syncAccessUpdate,
  validateRendezvousEndpoint,
} from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { CloudflareGuidedDeploy } from './CloudflareGuidedDeploy'
import styles from './CollaborationSettings.module.css'
import { SettingsSection } from './primitives'

// `alethe_managed` (an operator-run shared endpoint) is deliberately never offered here — see
// ADR-0002's amendment: Alethe never runs infrastructure that could see metadata across every
// user. Each person who wants online collaboration deploys and owns their own Cloudflare Worker
// (`advanced_custom`, guided by `CloudflareGuidedDeploy` below); `local_only` stays the only other
// choice, for people who don't want collaboration at all.
const modes = [
  'local_only',
  'advanced_custom',
] as const satisfies readonly CollaborationServiceMode[]

export function CollaborationSettings() {
  const t = useT()
  const modalContext = useUiStore((state) => state.modalContext)
  const autoOpenedCloudflareRef = useRef(false)
  const [settings, setSettings] = useState<CollaborationServiceSettings | null>(null)
  const [activation, setActivation] = useState<CollaborationActivationState>('disabled')
  const [endpoint, setEndpoint] = useState('')
  const [busy, setBusy] = useState(false)
  const [accessBusy, setAccessBusy] = useState<string | null>(null)
  const [accessRecords, setAccessRecords] = useState<AccessRecord[]>([])
  const [error, setError] = useState(false)
  const [showManualEndpoint, setShowManualEndpoint] = useState(false)

  const refresh = useCallback(async () => {
    const [nextSettings, nextActivation, nextAccessRecords] = await Promise.all([
      getCollaborationServiceSettings(),
      resolveCollaborationActivationState(),
      syncAccessList(),
    ])
    setSettings(nextSettings)
    setActivation(nextActivation)
    setAccessRecords(nextAccessRecords)
    setEndpoint((current) => current || nextSettings.customEndpoint || '')
  }, [])

  useEffect(() => {
    let active = true
    void refresh().catch(() => {
      if (active) setError(true)
    })
    const timer = window.setInterval(() => {
      if (active && settings?.enabled) void refresh().catch(() => setError(true))
    }, 5_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refresh, settings?.enabled])

  const selectMode = async (mode: CollaborationServiceMode) => {
    setBusy(true)
    setError(false)
    try {
      setSettings(
        await setCollaborationServiceMode(mode, mode === 'advanced_custom' ? endpoint : undefined),
      )
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  // Coming from the sidebar's "Instalar e configurar"/"Continuar configuração" Cloudflare card:
  // jump straight past the mode picker into the guided deploy flow, instead of leaving the user
  // stranded on the mode-selection screen with no visible install/login/deploy steps.
  useEffect(() => {
    if (autoOpenedCloudflareRef.current) return
    if (modalContext?.settingTarget !== 'collaboration-service') return
    if (!settings || settings.mode === 'advanced_custom') return
    autoOpenedCloudflareRef.current = true
    void selectMode('advanced_custom')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalContext, settings])

  const enable = async () => {
    if (!settings || settings.mode === 'local_only') return
    setBusy(true)
    setError(false)
    try {
      if (settings.mode === 'advanced_custom') {
        await setCollaborationServiceMode('advanced_custom', endpoint)
        await validateRendezvousEndpoint(endpoint)
      }
      await enableCollaborationService()
      await connectRendezvous()
      await refresh()
    } catch {
      setError(true)
      await refresh().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setError(false)
    try {
      await disableCollaborationService()
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const updateAccess = async (record: AccessRecord, operation: 'read' | 'dismiss' | 'defer') => {
    setAccessBusy(record.id)
    setError(false)
    try {
      await syncAccessUpdate(
        record.id,
        operation,
        operation === 'defer' ? Date.now() + 60 * 60 * 1_000 : undefined,
      )
      await refresh()
    } catch {
      setError(true)
    } finally {
      setAccessBusy(null)
    }
  }

  return (
    <>
      <SettingsSection
        id="collaboration-service"
        title={t('collaboration.settingsTitle')}
        description={t('collaboration.settingsDescription')}
      >
        <div className={styles.stack}>
          <div className={styles.modeGrid}>
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`${styles.modeButton} ${settings?.mode === mode ? styles.modeActive : ''}`}
                disabled={busy}
                onClick={() => void selectMode(mode)}
              >
                <span className={styles.modeHeading}>
                  <strong>{t(`collaboration.mode.${mode}.title`)}</strong>
                </span>
                <span>{t(`collaboration.mode.${mode}.description`)}</span>
              </button>
            ))}
          </div>

          {settings?.mode === 'advanced_custom' ? (
            <>
              <CloudflareGuidedDeploy onDeployed={(url) => setEndpoint(url)} />
              {endpoint && !showManualEndpoint ? (
                <div className={styles.endpointReadout}>
                  <span>{t('collaboration.workerAddress')}</span>
                  <code>{endpoint}</code>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setShowManualEndpoint(true)}
                  >
                    {t('collaboration.editManually')}
                  </button>
                </div>
              ) : (
                <label className={styles.endpoint}>
                  <span>{t('collaboration.customEndpoint')}</span>
                  <input
                    className={controls.input}
                    value={endpoint}
                    placeholder="https://rendezvous.example.com"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </label>
              )}
            </>
          ) : null}

          <div className={styles.notice}>
            <ShieldCheck size={16} aria-hidden="true" /> {t('collaboration.privacyTitle')}
            <ul>
              <li>{t('collaboration.privacyVisible')}</li>
              <li>{t('collaboration.privacyHidden')}</li>
              <li>{t('collaboration.ownWorkerRequired')}</li>
            </ul>
          </div>

          <div className={styles.statusRow}>
            <span>
              <Radio size={15} aria-hidden="true" /> {t('collaboration.statusLabel')}
            </span>
            <strong>{t(`collaboration.state.${activation}`)}</strong>
          </div>
          {error ? <p className={styles.error}>{t('collaboration.connectionError')}</p> : null}

          <div className={styles.actions}>
            {settings?.enabled ? (
              <button
                type="button"
                className={controls.btn}
                disabled={busy}
                onClick={() => void disable()}
              >
                {busy ? <Loader2 size={14} /> : null}
                {t('collaboration.disable')}
              </button>
            ) : (
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                disabled={
                  busy ||
                  !settings ||
                  settings.mode === 'local_only' ||
                  (settings.mode === 'advanced_custom' && !endpoint.trim())
                }
                onClick={() => void enable()}
              >
                {busy ? <Loader2 size={14} /> : null}
                {t('collaboration.enable')}
              </button>
            )}
          </div>
          <p className={styles.enableHint}>{t('collaboration.enableHint')}</p>

          <div className={styles.accessCenter}>
            <div className={styles.accessHeading}>
              <span>
                <Bell size={15} aria-hidden="true" /> {t('collaboration.access.title')}
              </span>
              <small>{t('collaboration.access.description')}</small>
            </div>
            {accessRecords.length === 0 ? (
              <p className={styles.accessEmpty}>{t('collaboration.access.empty')}</p>
            ) : (
              <div className={styles.accessList}>
                {accessRecords.map((record) => (
                  <article
                    key={record.id}
                    className={`${styles.accessItem} ${record.unread ? styles.accessUnread : ''}`}
                  >
                    <div className={styles.accessCopy}>
                      <span>{t(`collaboration.access.category.${record.category}`)}</span>
                      <strong>{t(`collaboration.access.kind.${record.kind}`)}</strong>
                    </div>
                    <div className={styles.accessActions}>
                      {record.unread ? (
                        <button
                          type="button"
                          className={controls.btn}
                          disabled={accessBusy === record.id}
                          onClick={() => void updateAccess(record, 'read')}
                        >
                          <Eye size={13} aria-hidden="true" />
                          {t('collaboration.access.read')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={controls.btn}
                        disabled={accessBusy === record.id}
                        onClick={() => void updateAccess(record, 'defer')}
                      >
                        <Clock3 size={13} aria-hidden="true" />
                        {t('collaboration.access.later')}
                      </button>
                      <button
                        type="button"
                        className={controls.btn}
                        disabled={accessBusy === record.id}
                        onClick={() => void updateAccess(record, 'dismiss')}
                      >
                        <X size={13} aria-hidden="true" />
                        {t('collaboration.access.dismiss')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>
    </>
  )
}

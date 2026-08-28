import {
  Archive,
  Check,
  Cloud,
  Copy,
  FolderSync,
  Globe,
  Laptop,
  Loader2,
  Pencil,
  RefreshCw,
  Share2,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { useCloudflareLoginOnly } from '../../hooks/useCloudflareLoginOnly'
import { type CloudflareProbeState, probeCloudflareState } from '../../lib/api/cloudflareDeploy'
import { exportPairingCode, regeneratePairingCode } from '../../lib/api/p2pBridge'
import {
  type CollaborationServiceSettings,
  connectRendezvous,
  disableCollaborationService,
  disconnectRendezvous,
  enableCollaborationService,
  getCollaborationServiceSettings,
  getRendezvousStatus,
  type RendezvousStatus,
} from '../../lib/api/syncRendezvous'
import { useT } from '../../lib/i18n'
import { downscaleAvatar } from '../../lib/image/downscaleAvatar'
import { PROJECT_SYNC_CAPABILITIES } from '../../lib/sync/contracts'
import {
  configureGoogleSync,
  disconnectGoogleSync,
  getGoogleSyncStatus,
  type GoogleSyncUser,
  openInBrowser,
  startGoogleSyncAuth,
  syncApproveDevice,
  type SyncDeviceRecord,
  syncRejectDevice,
  syncRemoveDevice,
  syncRenameDevice,
  syncRevokeDevice,
  syncRevokeGrant,
  type SyncSecuritySnapshot,
  syncSecuritySnapshot,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { GoogleIcon } from '../icons/AgentIcons'
import styles from './MeshSidebarView.module.css'

// Deep-links directly to the "Create OAuth client" flow for an existing/new Google Cloud
// project, scoped to Desktop app credentials — the exact type Alethe's loopback PKCE flow needs.
const GOOGLE_CLOUD_CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials'

export function MeshSidebarView() {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal_)
  const projects = useProjectsStore((s) => s.projects)
  const preferences = useProjectsStore((s) => s.preferences)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]
  const canTransfer = PROJECT_SYNC_CAPABILITIES.projectTransfer === 'available'
  const [security, setSecurity] = useState<SyncSecuritySnapshot | null>(null)
  const [google, setGoogle] = useState<GoogleSyncUser | null>(null)
  const [securityError, setSecurityError] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [googleSetupStage, setGoogleSetupStage] = useState<'closed' | 'explain' | 'form'>('closed')
  const [googleClientId, setGoogleClientId] = useState('')
  const [googleClientSecret, setGoogleClientSecret] = useState('')
  // Real Google Desktop OAuth client IDs always look like `<digits>-<hash>.apps.googleusercontent.com`.
  const googleClientIdFormatValid = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(
    googleClientId.trim(),
  )
  const [renamingDevice, setRenamingDevice] = useState(false)
  const [deviceNameDraft, setDeviceNameDraft] = useState('')
  const [deviceActionBusy, setDeviceActionBusy] = useState<string | null>(null)
  const [deviceActionError, setDeviceActionError] = useState(false)
  const [showInvitePanel, setShowInvitePanel] = useState(false)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false)
  const [pairingCodeBusy, setPairingCodeBusy] = useState(false)
  const [pairingCodeError, setPairingCodeError] = useState(false)
  const [deviceIdCopied, setDeviceIdCopied] = useState(false)
  const [grantActionBusy, setGrantActionBusy] = useState<string | null>(null)
  const [rendezvousSettings, setRendezvousSettings] = useState<CollaborationServiceSettings | null>(
    null,
  )
  const [rendezvousStatus, setRendezvousStatus] = useState<RendezvousStatus | null>(null)
  const [rendezvousBusy, setRendezvousBusy] = useState(false)
  const [rendezvousError, setRendezvousError] = useState(false)
  const [cloudflareProbe, setCloudflareProbe] = useState<CloudflareProbeState | null>(null)
  const cloudflareLogin = useCloudflareLoginOnly()

  const refreshSecurity = () =>
    syncSecuritySnapshot()
      .then((snapshot) => {
        setSecurity(snapshot)
        setSecurityError(false)
        return snapshot
      })
      .catch(() => {
        setSecurity(null)
        setSecurityError(true)
        return null
      })

  useEffect(() => {
    let active = true
    Promise.all([syncSecuritySnapshot(), getGoogleSyncStatus()])
      .then(([snapshot, status]) => {
        if (!active) return
        setSecurity(snapshot)
        setGoogle(status)
        setSecurityError(false)
      })
      .catch(() => {
        if (!active) return
        setSecurity(null)
        setSecurityError(true)
      })
    return () => {
      active = false
    }
  }, [])

  const refreshRendezvous = () =>
    Promise.all([getCollaborationServiceSettings(), getRendezvousStatus()])
      .then(([settings, status]) => {
        setRendezvousSettings(settings)
        setRendezvousStatus(status)
        setRendezvousError(false)
      })
      .catch(() => setRendezvousError(true))

  useEffect(() => {
    void refreshRendezvous()
  }, [])

  const workerConfigured = Boolean(rendezvousSettings?.validatedEndpoint)

  const refreshCloudflareProbe = () =>
    probeCloudflareState()
      .then(setCloudflareProbe)
      .catch(() => setCloudflareProbe(null))

  useEffect(() => {
    if (workerConfigured) return
    void refreshCloudflareProbe()
  }, [workerConfigured])

  useEffect(() => {
    if (cloudflareLogin.step === 'success') void refreshCloudflareProbe()
  }, [cloudflareLogin.step])

  const rendezvousOnline = rendezvousStatus?.state === 'online'
  const rendezvousConnecting =
    rendezvousStatus?.state === 'connecting' ||
    rendezvousStatus?.state === 'retrying_after_transient_failure'

  const toggleRendezvous = async () => {
    setRendezvousBusy(true)
    setRendezvousError(false)
    try {
      if (rendezvousSettings?.enabled) {
        await disconnectRendezvous().catch(() => undefined)
        await disableCollaborationService()
      } else {
        await enableCollaborationService()
        await connectRendezvous()
      }
      await refreshRendezvous()
    } catch {
      setRendezvousError(true)
    } finally {
      setRendezvousBusy(false)
    }
  }

  const account = security?.account ?? null
  const devices = security?.devices ?? []
  const thisDevice = devices.find((device) => device.deviceId === security?.localDeviceId) ?? null
  const otherDevices = devices.filter((device) => device.deviceId !== security?.localDeviceId)
  const activeGrants = security?.grants.filter((grant) => !grant.revokedAtMs) ?? []

  const loadPairingCode = async () => {
    setPairingCodeBusy(true)
    setPairingCodeError(false)
    try {
      const rawAvatar = preferences.profileImageUrl?.trim() || null
      const thumbnail = rawAvatar ? await downscaleAvatar(rawAvatar) : null
      const code = await exportPairingCode(preferences.displayName || null, thumbnail)
      setPairingCode(code)
    } catch (cause) {
      console.error('[mesh] exportPairingCode failed', cause)
      setPairingCodeError(true)
    } finally {
      setPairingCodeBusy(false)
    }
  }

  const regenerateCode = async () => {
    setPairingCodeBusy(true)
    setPairingCodeError(false)
    try {
      const rawAvatar = preferences.profileImageUrl?.trim() || null
      const thumbnail = rawAvatar ? await downscaleAvatar(rawAvatar) : null
      const code = await regeneratePairingCode(preferences.displayName || null, thumbnail)
      setPairingCode(code)
      setPairingCodeCopied(false)
    } catch (cause) {
      console.error('[mesh] regeneratePairingCode failed', cause)
      setPairingCodeError(true)
    } finally {
      setPairingCodeBusy(false)
    }
  }

  const copyPairingCode = async () => {
    if (!pairingCode) return
    try {
      await navigator.clipboard.writeText(pairingCode)
      setPairingCodeCopied(true)
      window.setTimeout(() => setPairingCodeCopied(false), 1500)
    } catch {
      setPairingCodeCopied(false)
    }
  }

  useEffect(() => {
    if (showInvitePanel && !pairingCode) {
      void loadPairingCode()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInvitePanel])

  const runDeviceAction = async (deviceId: string, action: () => Promise<unknown>) => {
    setDeviceActionBusy(deviceId)
    setDeviceActionError(false)
    try {
      await action()
      await refreshSecurity()
    } catch {
      setDeviceActionError(true)
    } finally {
      setDeviceActionBusy(null)
    }
  }

  const startRenameDevice = () => {
    setDeviceNameDraft(thisDevice?.displayName ?? '')
    setRenamingDevice(true)
  }

  const submitRenameDevice = async () => {
    const name = deviceNameDraft.trim()
    if (!name || !thisDevice) {
      setRenamingDevice(false)
      return
    }
    await runDeviceAction(thisDevice.deviceId, () => syncRenameDevice(name))
    setRenamingDevice(false)
  }

  const deviceLabel = (device: SyncDeviceRecord) =>
    device.displayName.trim() || t('mesh.deviceUnnamed')

  const canInviteNow = thisDevice?.trust === 'trusted' && Boolean(activeProject)

  const copyDeviceId = async (deviceId: string) => {
    try {
      await navigator.clipboard.writeText(deviceId)
      setDeviceIdCopied(true)
      window.setTimeout(() => setDeviceIdCopied(false), 1500)
    } catch {
      setDeviceIdCopied(false)
    }
  }

  const revokeGrant = async (grantId: string) => {
    setGrantActionBusy(grantId)
    try {
      await syncRevokeGrant(grantId)
      await refreshSecurity()
    } catch {
      setDeviceActionError(true)
    } finally {
      setGrantActionBusy(null)
    }
  }

  const connectGoogle = async () => {
    setAuthBusy(true)
    setAuthError(false)
    try {
      const status = await startGoogleSyncAuth()
      const snapshot = await syncSecuritySnapshot()
      setGoogle(status)
      setSecurity(snapshot)
      setSecurityError(false)
    } catch {
      setAuthError(true)
    } finally {
      setAuthBusy(false)
    }
  }

  const disconnectGoogle = async () => {
    setAuthBusy(true)
    setAuthError(false)
    try {
      await disconnectGoogleSync()
      const status = await getGoogleSyncStatus()
      const snapshot = await syncSecuritySnapshot()
      setGoogle(status)
      setSecurity(snapshot)
      setSecurityError(false)
    } catch {
      setAuthError(true)
    } finally {
      setAuthBusy(false)
    }
  }

  const saveGoogleConfiguration = async () => {
    setAuthBusy(true)
    setAuthError(false)
    try {
      await configureGoogleSync(googleClientId, googleClientSecret.trim() || undefined)
      const status = await getGoogleSyncStatus()
      setGoogle(status)
      setGoogleSetupStage('closed')
      setGoogleClientId('')
      setGoogleClientSecret('')
    } catch {
      setAuthError(true)
    } finally {
      setAuthBusy(false)
    }
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <Globe size={15} className={styles.headerIcon} />
          <strong className={styles.title}>{t('mesh.title')}</strong>
        </div>
        <span className={styles.badgeLocal}>{t('mesh.prototype')}</span>
      </header>

      <section className={styles.section}>
        <div className={styles.authCard}>
          <div className={styles.authInfo}>
            <span className={styles.authLabel}>{t('mesh.syncAccount')}</span>
            <span className={styles.authStatus}>
              {securityError
                ? t('mesh.securityLoadFailed')
                : authError
                  ? t('mesh.oauthFailed')
                  : account
                    ? t('mesh.connectedAccount', { name: account.displayName })
                    : google && !google.configured
                      ? t('mesh.oauthNotConfigured')
                      : t('mesh.identityUnavailable')}
            </span>
          </div>
          <div className={styles.authButtonsRow}>
            <button
              type="button"
              className={`${styles.loginGoogleBtn} ${account ? styles.loginGoogleBtnConnected : ''}`}
              disabled={authBusy}
              title={google?.configured ? undefined : t('mesh.oauthNotConfigured')}
              onClick={() => {
                if (account) void disconnectGoogle()
                else if (google?.configured) void connectGoogle()
                else setGoogleSetupStage((stage) => (stage === 'closed' ? 'explain' : 'closed'))
              }}
            >
              {authBusy ? <Loader2 size={14} className={styles.spin} /> : <GoogleIcon size={14} />}
              <span>
                {authBusy
                  ? t('mesh.authenticating')
                  : account
                    ? t('mesh.disconnectAccount')
                    : google?.configured
                      ? t('mesh.connectAccount')
                      : t('mesh.configureGoogle')}
              </span>
            </button>
            {google?.configured && !account ? (
              <button
                type="button"
                className={styles.editOAuthConfigBtn}
                disabled={authBusy}
                title={t('mesh.editGoogleConfiguration')}
                onClick={() =>
                  setGoogleSetupStage((stage) => (stage === 'form' ? 'closed' : 'form'))
                }
              >
                {t('mesh.editGoogleConfiguration')}
              </button>
            ) : null}
          </div>
          {!google?.configured ? (
            <div
              className={`${styles.oauthSetupWrap} ${
                googleSetupStage === 'explain' ? styles.oauthSetupWrapOpen : ''
              }`}
            >
              <div>
                <div className={styles.oauthExplain}>
                  <p>{t('mesh.googleSetupExplainIntro')}</p>
                  <ol>
                    <li>{t('mesh.googleSetupExplainStep1')}</li>
                    <li>{t('mesh.googleSetupExplainStep2')}</li>
                    <li>{t('mesh.googleSetupExplainStep3')}</li>
                    <li>{t('mesh.googleSetupExplainStep4')}</li>
                  </ol>
                  <button
                    type="button"
                    className={styles.saveOAuthBtn}
                    onClick={() => {
                      void openInBrowser(GOOGLE_CLOUD_CREDENTIALS_URL)
                      setGoogleSetupStage('form')
                    }}
                  >
                    {t('mesh.googleSetupProceed')}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {!google?.configured || !account ? (
            <div
              className={`${styles.oauthSetupWrap} ${
                googleSetupStage === 'form' ? styles.oauthSetupWrapOpen : ''
              }`}
            >
              <div>
                <div className={styles.oauthSetup}>
                  <label htmlFor="google-oauth-client-id">{t('mesh.googleClientId')}</label>
                  <input
                    id="google-oauth-client-id"
                    className={
                      googleClientId.trim() && !googleClientIdFormatValid
                        ? styles.oauthSetupInvalid
                        : undefined
                    }
                    value={googleClientId}
                    placeholder="123…apps.googleusercontent.com"
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={Boolean(googleClientId.trim()) && !googleClientIdFormatValid}
                    onChange={(event) => setGoogleClientId(event.target.value)}
                  />
                  <span
                    className={
                      googleClientId.trim() && !googleClientIdFormatValid
                        ? styles.oauthSetupHint
                        : undefined
                    }
                  >
                    {googleClientId.trim() && !googleClientIdFormatValid
                      ? t('mesh.googleClientIdInvalid')
                      : t('mesh.googleClientIdHint')}
                  </span>
                  <label htmlFor="google-oauth-client-secret">{t('mesh.googleClientSecret')}</label>
                  <input
                    id="google-oauth-client-secret"
                    type="password"
                    value={googleClientSecret}
                    placeholder="GOCSPX-…"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setGoogleClientSecret(event.target.value)}
                  />
                  <span>{t('mesh.googleClientSecretHint')}</span>
                  <button
                    type="button"
                    className={styles.saveOAuthBtn}
                    disabled={authBusy || !googleClientId.trim() || !googleClientIdFormatValid}
                    onClick={() => void saveGoogleConfiguration()}
                  >
                    {t('mesh.saveConfiguration')}
                  </button>
                  <button
                    type="button"
                    className={styles.reopenPageBtn}
                    onClick={() => void openInBrowser(GOOGLE_CLOUD_CREDENTIALS_URL)}
                  >
                    {t('mesh.googleSetupReopenPage')}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.authCard}>
          <div className={styles.authInfo}>
            <span className={styles.authLabel}>{t('mesh.cloudflareWorker')}</span>
            <span className={styles.authStatus}>
              {rendezvousError
                ? t('mesh.cloudflareStatusFailed')
                : workerConfigured
                  ? rendezvousOnline
                    ? t('mesh.cloudflareOnline')
                    : rendezvousConnecting
                      ? t('mesh.cloudflareConnecting')
                      : t('mesh.cloudflareOffline')
                  : cloudflareLogin.step === 'running'
                    ? t('mesh.cloudflareLoggingIn')
                    : cloudflareProbe?.installed && cloudflareProbe.loggedIn
                      ? t('mesh.cloudflareReadyToDeploy')
                      : cloudflareProbe?.installed
                        ? t('mesh.cloudflareNotLoggedIn')
                        : t('mesh.cloudflareNotConfigured')}
            </span>
          </div>
          <div className={styles.authButtonsRow}>
            {workerConfigured ? (
              <button
                type="button"
                className={`${styles.loginGoogleBtn} ${rendezvousOnline ? styles.loginGoogleBtnConnected : ''}`}
                disabled={rendezvousBusy}
                onClick={() => void toggleRendezvous()}
              >
                {rendezvousBusy ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Cloud size={14} />
                )}
                <span>
                  {rendezvousBusy
                    ? t('mesh.cloudflareWorking')
                    : rendezvousSettings?.enabled
                      ? t('mesh.cloudflareDisconnect')
                      : t('mesh.cloudflareConnect')}
                </span>
              </button>
            ) : cloudflareProbe?.installed && !cloudflareProbe.loggedIn ? (
              <button
                type="button"
                className={styles.loginGoogleBtn}
                onClick={() =>
                  cloudflareLogin.step === 'running'
                    ? cloudflareLogin.reset()
                    : void cloudflareLogin.start()
                }
              >
                {cloudflareLogin.step === 'running' ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Cloud size={14} />
                )}
                <span>
                  {cloudflareLogin.step === 'running'
                    ? t('mesh.cloudflareCancel')
                    : t('mesh.cloudflareConnectAccount')}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className={styles.loginGoogleBtn}
                onClick={() =>
                  openModal('preferences', {
                    category: 'account',
                    settingTarget: 'collaboration-service',
                  })
                }
              >
                <Cloud size={14} />
                <span>
                  {cloudflareProbe?.installed && cloudflareProbe.loggedIn
                    ? t('mesh.cloudflareContinueSetup')
                    : t('mesh.cloudflareSetUp')}
                </span>
              </button>
            )}
          </div>
          {!workerConfigured && !cloudflareProbe?.installed ? (
            <span className={styles.infoHint}>{t('mesh.cloudflareExplain')}</span>
          ) : null}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.deviceCard}>
          <div className={styles.deviceHeader}>
            <Laptop size={14} />
            <span>{t('mesh.thisDevice')}</span>
            {thisDevice ? (
              <span className={styles.deviceTrustPill} data-trust={thisDevice.trust}>
                {t(`mesh.deviceTrust.${thisDevice.trust}`)}
              </span>
            ) : null}
          </div>
          {!security && !securityError ? (
            <Loader2 size={13} className={styles.spin} />
          ) : thisDevice ? (
            <>
              {renamingDevice ? (
                <div className={styles.deviceRenameRow}>
                  <input
                    autoFocus
                    value={deviceNameDraft}
                    maxLength={64}
                    onChange={(event) => setDeviceNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitRenameDevice()
                      if (event.key === 'Escape') setRenamingDevice(false)
                    }}
                  />
                  <button
                    type="button"
                    className={styles.deviceActionBtn}
                    disabled={deviceActionBusy === thisDevice.deviceId}
                    onClick={() => void submitRenameDevice()}
                    title={t('mesh.deviceSaveName')}
                  >
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.deviceActionBtn}
                    onClick={() => setRenamingDevice(false)}
                    title={t('mesh.deviceCancel')}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <div className={styles.deviceNameRow}>
                  <span className={styles.deviceName}>{deviceLabel(thisDevice)}</span>
                  <button
                    type="button"
                    className={styles.deviceActionBtn}
                    onClick={startRenameDevice}
                    title={t('mesh.deviceRename')}
                  >
                    <Pencil size={12} />
                  </button>
                </div>
              )}
              <div className={styles.deviceFingerprintRow}>
                <span className={styles.deviceFingerprintLabel}>{t('mesh.deviceFingerprint')}</span>
                <code className={styles.deviceId} title={thisDevice.deviceId}>
                  {thisDevice.deviceId}
                </code>
                <button
                  type="button"
                  className={styles.deviceActionBtn}
                  onClick={() => void copyDeviceId(thisDevice.deviceId)}
                  title={t('mesh.deviceCopyId')}
                >
                  {deviceIdCopied ? (
                    <Check size={11} className={styles.successIcon} />
                  ) : (
                    <Copy size={11} />
                  )}
                </button>
              </div>
            </>
          ) : (
            <span className={styles.deviceName}>{t('mesh.deviceNotRegistered')}</span>
          )}
        </div>

        {otherDevices.length > 0 ? (
          <ul className={styles.deviceList}>
            {otherDevices.map((device) => (
              <li key={device.deviceId} className={styles.deviceListItem}>
                <div className={styles.deviceListInfo}>
                  <span className={styles.deviceListName}>{deviceLabel(device)}</span>
                  <span className={styles.deviceTrust} data-trust={device.trust}>
                    {t(`mesh.deviceTrust.${device.trust}`)}
                  </span>
                </div>
                <div className={styles.deviceListActions}>
                  {device.trust === 'pending' ? (
                    <>
                      <button
                        type="button"
                        className={styles.deviceActionBtn}
                        disabled={deviceActionBusy === device.deviceId}
                        title={t('mesh.deviceApprove')}
                        onClick={() =>
                          void runDeviceAction(device.deviceId, () =>
                            syncApproveDevice(device.deviceId),
                          )
                        }
                      >
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        className={styles.deviceActionBtn}
                        disabled={deviceActionBusy === device.deviceId}
                        title={t('mesh.deviceReject')}
                        onClick={() =>
                          void runDeviceAction(device.deviceId, () =>
                            syncRejectDevice(device.deviceId),
                          )
                        }
                      >
                        <X size={12} />
                      </button>
                    </>
                  ) : null}
                  {device.trust === 'trusted' ? (
                    <button
                      type="button"
                      className={styles.deviceActionBtn}
                      disabled={deviceActionBusy === device.deviceId}
                      title={t('mesh.deviceRevoke')}
                      onClick={() =>
                        void runDeviceAction(device.deviceId, () =>
                          syncRevokeDevice(device.deviceId),
                        )
                      }
                    >
                      <ShieldAlert size={12} />
                    </button>
                  ) : null}
                  {device.trust === 'revoked' ? (
                    <button
                      type="button"
                      className={styles.deviceActionBtn}
                      disabled={deviceActionBusy === device.deviceId}
                      title={t('mesh.deviceRemove')}
                      onClick={() =>
                        void runDeviceAction(device.deviceId, () =>
                          syncRemoveDevice(device.deviceId),
                        )
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {deviceActionError ? (
          <span className={styles.deviceActionError}>{t('mesh.deviceActionFailed')}</span>
        ) : null}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.accessCenter')}</span>
        </div>
        <div className={styles.accessGrid}>
          <div className={styles.accessMetric}>
            <Users size={14} />
            <span>{t('mesh.activeGrants')}</span>
            <strong>{activeGrants.length}</strong>
          </div>
        </div>

        {activeGrants.length > 0 ? (
          <ul className={styles.deviceList}>
            {activeGrants.map((grant) => (
              <li key={grant.grantId} className={styles.deviceListItem}>
                <div className={styles.deviceListInfo}>
                  <span className={styles.deviceListName}>{grant.accountId}</span>
                  <span className={styles.deviceTrust}>
                    {grant.permissions
                      .map((permission) => t(`mesh.permission.${permission}`))
                      .join(', ')}
                  </span>
                </div>
                <div className={styles.deviceListActions}>
                  <button
                    type="button"
                    className={styles.deviceActionBtn}
                    disabled={grantActionBusy === grant.grantId}
                    title={t('mesh.revokeGrant')}
                    onClick={() => void revokeGrant(grant.grantId)}
                  >
                    <X size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.projectSync')}</span>
        </div>

        {activeProject ? (
          <div className={styles.projectSyncCard}>
            <div className={styles.projectInfo}>
              <FolderSync size={15} className={styles.syncIcon} />
              <div className={styles.projectNames}>
                <strong>{activeProject.name}</strong>
                <span className={styles.projectPath}>{activeProject.defaultCwd}</span>
              </div>
            </div>

            <div className={styles.actionButtons}>
              <button
                type="button"
                className={styles.primaryAction}
                disabled={!canInviteNow}
                title={canInviteNow ? undefined : t('mesh.inviteUnavailableHint')}
                onClick={() => setShowInvitePanel((visible) => !visible)}
              >
                <Share2 size={13} />
                <span>{t('mesh.inviteFriend')}</span>
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                disabled={!canTransfer}
                title={t('mesh.unavailableHint')}
              >
                <Archive size={13} />
                <span>{t('mesh.vault')}</span>
              </button>
            </div>

            {showInvitePanel ? (
              <div className={styles.oauthSetup}>
                <span className={styles.infoHint}>{t('mesh.sharePairingCodeHint')}</span>
                {pairingCodeBusy ? (
                  <div className={styles.loadingRow}>
                    <Loader2 size={14} className={styles.spin} />
                  </div>
                ) : pairingCode ? (
                  <>
                    <div className={styles.deviceRenameRow}>
                      <input
                        className={styles.redeemInputMono}
                        value={pairingCode}
                        readOnly
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className={styles.deviceActionBtn}
                        onClick={() => void copyPairingCode()}
                        title={t('mesh.copyPairingCode')}
                      >
                        {pairingCodeCopied ? (
                          <Check size={12} className={styles.successIcon} />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                      <button
                        type="button"
                        className={styles.deviceActionBtn}
                        onClick={() => void regenerateCode()}
                        title={t('mesh.generateNewCode')}
                        disabled={pairingCodeBusy}
                      >
                        <RefreshCw size={12} className={pairingCodeBusy ? styles.spin : ''} />
                      </button>
                    </div>
                    {pairingCodeCopied ? (
                      <span className={styles.successHint}>{t('mesh.pairingCodeCopied')}</span>
                    ) : null}
                  </>
                ) : pairingCodeError ? (
                  <span className={styles.deviceActionError}>{t('chat.contacts.exportFailed')}</span>
                ) : null}
                <button
                  type="button"
                  className={styles.saveOAuthBtn}
                  onClick={() => setShowInvitePanel(false)}
                >
                  {t('mesh.deviceCancel')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            compact
            icon={<FolderSync size={18} />}
            title={t('mesh.noProject')}
            description={t('mesh.noProjectDesc')}
          />
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>{t('mesh.security')}</span>
        </div>
        <div className={styles.securityPill}>
          <ShieldAlert size={14} className={styles.shieldIcon} />
          <span>{t('mesh.securityUnavailable')}</span>
        </div>
      </section>
    </div>
  )
}

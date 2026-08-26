import {
  Archive,
  Check,
  Cloud,
  Copy,
  FolderSync,
  Globe,
  Inbox,
  Laptop,
  Loader2,
  Pencil,
  Share2,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { useCloudflareLoginOnly } from '../../hooks/useCloudflareLoginOnly'
import { type CloudflareProbeState, probeCloudflareState } from '../../lib/api/cloudflareDeploy'
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
import { PROJECT_SYNC_CAPABILITIES, type SyncPermission } from '../../lib/sync/contracts'
import { buildInvitationLink, parseInvitationLink } from '../../lib/sync/invitationLink'
import {
  configureGoogleSync,
  disconnectGoogleSync,
  getGoogleSyncStatus,
  type GoogleSyncUser,
  listDirectory,
  openInBrowser,
  startGoogleSyncAuth,
  syncApproveDevice,
  type SyncDeviceRecord,
  syncIssueInvitation,
  syncRedeemInvitation,
  syncRejectDevice,
  syncRemoveDevice,
  syncRenameDevice,
  syncRevokeDevice,
  syncRevokeGrant,
  syncRevokeInvitation,
  type SyncSecuritySnapshot,
  syncSecuritySnapshot,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { GoogleIcon } from '../icons/AgentIcons'
import styles from './MeshSidebarView.module.css'

const INVITATION_PERMISSION_PRESETS = [
  { id: 'viewOnly', permissions: ['read'] as SyncPermission[] },
  { id: 'reviewer', permissions: ['read', 'export'] as SyncPermission[] },
  { id: 'collaborator', permissions: ['read', 'write'] as SyncPermission[] },
] as const

const INVITATION_EXPIRY_CHOICES_MS = [
  { id: '1h', ms: 60 * 60 * 1000 },
  { id: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
] as const

const SENSITIVE_PERMISSIONS: SyncPermission[] = ['write', 'delete', 'invite', 'admin']

// Deep-links directly to the "Create OAuth client" flow for an existing/new Google Cloud
// project, scoped to Desktop app credentials — the exact type Alethe's loopback PKCE flow needs.
const GOOGLE_CLOUD_CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials'

export function MeshSidebarView() {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal_)
  const projects = useProjectsStore((s) => s.projects)
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
  const [recipientAccountId, setRecipientAccountId] = useState('')
  const [invitePresetId, setInvitePresetId] = useState<
    (typeof INVITATION_PERMISSION_PRESETS)[number]['id']
  >(INVITATION_PERMISSION_PRESETS[0].id)
  const [inviteExpiryId, setInviteExpiryId] =
    useState<(typeof INVITATION_EXPIRY_CHOICES_MS)[number]['id']>('24h')
  const [inviteConfirming, setInviteConfirming] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteError, setInviteError] = useState(false)
  const [issuedLink, setIssuedLink] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const [deviceIdCopied, setDeviceIdCopied] = useState(false)
  const [invitationActionBusy, setInvitationActionBusy] = useState<string | null>(null)
  const [grantActionBusy, setGrantActionBusy] = useState<string | null>(null)
  const [redeemInput, setRedeemInput] = useState('')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)
  const redeemFormatValid = parseInvitationLink(redeemInput.trim()) !== null
  const [projectFolders, setProjectFolders] = useState<string[] | null>(null)
  const [foldersError, setFoldersError] = useState(false)
  const [blockedFolders, setBlockedFolders] = useState<Set<string>>(new Set())
  const [rendezvousSettings, setRendezvousSettings] = useState<CollaborationServiceSettings | null>(
    null,
  )
  const [rendezvousStatus, setRendezvousStatus] = useState<RendezvousStatus | null>(null)
  const [rendezvousBusy, setRendezvousBusy] = useState(false)
  const [rendezvousError, setRendezvousError] = useState(false)
  const [cloudflareProbe, setCloudflareProbe] = useState<CloudflareProbeState | null>(null)
  const cloudflareLogin = useCloudflareLoginOnly()

  useEffect(() => {
    if (!showInvitePanel || !activeProject?.defaultCwd) return
    let active = true
    setFoldersError(false)
    listDirectory(activeProject.defaultCwd)
      .then((listing) => {
        if (!active) return
        setProjectFolders(
          listing.entries.filter((entry) => entry.is_dir).map((entry) => entry.name),
        )
      })
      .catch(() => {
        if (active) setFoldersError(true)
      })
    return () => {
      active = false
    }
  }, [showInvitePanel, activeProject])

  const toggleBlockedFolder = (name: string) => {
    setBlockedFolders((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

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
  const pendingInvitations = security?.invitations.filter((item) => item.state === 'created') ?? []
  const activeGrants = security?.grants.filter((grant) => !grant.revokedAtMs) ?? []

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
  const outgoingInvitations =
    security?.invitations.filter((item) => item.issuerDeviceId === thisDevice?.deviceId) ?? []
  const selectedPreset =
    INVITATION_PERMISSION_PRESETS.find((preset) => preset.id === invitePresetId) ??
    INVITATION_PERMISSION_PRESETS[0]
  const selectedPermissions = selectedPreset.permissions
  const requiresConfirmation = selectedPermissions.some((permission) =>
    SENSITIVE_PERMISSIONS.includes(permission),
  )

  const resetInvitePanel = () => {
    setShowInvitePanel(false)
    setRecipientAccountId('')
    setInvitePresetId(INVITATION_PERMISSION_PRESETS[0].id)
    setInviteExpiryId('24h')
    setInviteConfirming(false)
    setInviteError(false)
    setIssuedLink(null)
    setLinkCopied(false)
    setBlockedFolders(new Set())
    setProjectFolders(null)
    setFoldersError(false)
  }

  const submitInvite = async () => {
    if (!activeProject || !recipientAccountId.trim()) return
    if (requiresConfirmation && !inviteConfirming) {
      setInviteConfirming(true)
      return
    }
    setInviteBusy(true)
    setInviteError(false)
    try {
      const expiryMs =
        INVITATION_EXPIRY_CHOICES_MS.find((choice) => choice.id === inviteExpiryId)?.ms ??
        INVITATION_EXPIRY_CHOICES_MS[0].ms
      const issued = await syncIssueInvitation({
        projectId: activeProject.id,
        recipientAccountId: recipientAccountId.trim(),
        permissions: selectedPermissions,
        pathScopes: Array.from(blockedFolders, (name) => ({
          effect: 'deny' as const,
          pattern: `${name}/**`,
        })),
        expiresAtMs: Date.now() + expiryMs,
      })
      setIssuedLink(buildInvitationLink(issued.invitation.invitationId, issued.bearerToken))
      setInviteConfirming(false)
      await refreshSecurity()
    } catch {
      setInviteError(true)
    } finally {
      setInviteBusy(false)
    }
  }

  const copyDeviceId = async (deviceId: string) => {
    try {
      await navigator.clipboard.writeText(deviceId)
      setDeviceIdCopied(true)
      window.setTimeout(() => setDeviceIdCopied(false), 1500)
    } catch {
      setDeviceIdCopied(false)
    }
  }

  const copyIssuedLink = async () => {
    if (!issuedLink) return
    try {
      await navigator.clipboard.writeText(issuedLink)
      setLinkCopied(true)
    } catch {
      setLinkCopied(false)
    }
  }

  const revokeInvitation = async (invitationId: string) => {
    setInvitationActionBusy(invitationId)
    try {
      await syncRevokeInvitation(invitationId)
      await refreshSecurity()
    } catch {
      setDeviceActionError(true)
    } finally {
      setInvitationActionBusy(null)
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

  const submitRedeem = async () => {
    const parsed = parseInvitationLink(redeemInput.trim())
    if (!parsed) {
      setRedeemError(t('mesh.redeemInvalidLink'))
      return
    }
    setRedeemBusy(true)
    setRedeemError(null)
    try {
      await syncRedeemInvitation(parsed.invitationId, parsed.bearerToken)
      setRedeemInput('')
      await refreshSecurity()
    } catch {
      setRedeemError(t('mesh.redeemFailed'))
    } finally {
      setRedeemBusy(false)
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
            <Inbox size={14} />
            <span>{t('mesh.pendingInvitations')}</span>
            <strong>{pendingInvitations.length}</strong>
          </div>
          <div className={styles.accessMetric}>
            <Users size={14} />
            <span>{t('mesh.activeGrants')}</span>
            <strong>{activeGrants.length}</strong>
          </div>
        </div>

        {outgoingInvitations.length > 0 ? (
          <ul className={styles.deviceList}>
            {outgoingInvitations.map((invitation) => (
              <li key={invitation.invitationId} className={styles.deviceListItem}>
                <div className={styles.deviceListInfo}>
                  <span className={styles.deviceListName}>{invitation.recipientAccountId}</span>
                  <span className={styles.deviceTrust} data-trust={invitation.state}>
                    {t(`mesh.invitationState.${invitation.state}`)}
                  </span>
                </div>
                {invitation.state === 'created' ? (
                  <div className={styles.deviceListActions}>
                    <button
                      type="button"
                      className={styles.deviceActionBtn}
                      disabled={invitationActionBusy === invitation.invitationId}
                      title={t('mesh.revokeInvitation')}
                      onClick={() => void revokeInvitation(invitation.invitationId)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

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

        <div className={styles.deviceRenameRow}>
          <input
            className={
              redeemInput.trim() && !redeemFormatValid
                ? `${styles.redeemInputMono} ${styles.redeemInputInvalid}`
                : styles.redeemInputMono
            }
            value={redeemInput}
            placeholder={t('mesh.redeemPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(redeemInput.trim()) && !redeemFormatValid}
            onChange={(event) => {
              setRedeemInput(event.target.value)
              setRedeemError(null)
            }}
          />
          <button
            type="button"
            className={styles.deviceActionBtn}
            disabled={redeemBusy || !redeemInput.trim() || !redeemFormatValid}
            title={t('mesh.redeemInvitation')}
            onClick={() => void submitRedeem()}
          >
            {redeemBusy ? <Loader2 size={12} className={styles.spin} /> : <Check size={12} />}
          </button>
        </div>
        {redeemInput.trim() && !redeemFormatValid ? (
          <span className={styles.deviceActionError}>{t('mesh.redeemInvalidLink')}</span>
        ) : redeemError ? (
          <span className={styles.deviceActionError}>{redeemError}</span>
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
                {issuedLink ? (
                  <>
                    <span>{t('mesh.invitationIssuedOnce')}</span>
                    <div className={styles.deviceRenameRow}>
                      <code className={styles.deviceId}>{issuedLink}</code>
                      <button
                        type="button"
                        className={styles.deviceActionBtn}
                        onClick={() => void copyIssuedLink()}
                        title={t('mesh.copyLink')}
                      >
                        {linkCopied ? (
                          <Check size={12} className={styles.successIcon} />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                    </div>
                    <button
                      type="button"
                      className={styles.saveOAuthBtn}
                      onClick={resetInvitePanel}
                    >
                      {t('mesh.deviceCancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <label htmlFor="invite-recipient-account">{t('mesh.recipientAccount')}</label>
                    <input
                      id="invite-recipient-account"
                      value={recipientAccountId}
                      placeholder="recipient@example.com"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => {
                        setRecipientAccountId(event.target.value)
                        setInviteConfirming(false)
                      }}
                    />
                    <label htmlFor="invite-permission-preset">{t('mesh.permissionPreset')}</label>
                    <select
                      id="invite-permission-preset"
                      value={invitePresetId}
                      onChange={(event) => {
                        setInvitePresetId(
                          event.target
                            .value as (typeof INVITATION_PERMISSION_PRESETS)[number]['id'],
                        )
                        setInviteConfirming(false)
                      }}
                    >
                      {INVITATION_PERMISSION_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {t(`mesh.permissionPreset.${preset.id}`)}
                        </option>
                      ))}
                    </select>
                    <span className={styles.permissionSummary}>
                      {selectedPermissions
                        .map((permission) => t(`mesh.permission.${permission}`))
                        .join(', ')}
                    </span>
                    <label>{t('mesh.folderScopes')}</label>
                    <span>{t('mesh.folderScopesHint')}</span>
                    {foldersError ? (
                      <span className={styles.oauthSetupHint}>{t('mesh.folderScopesError')}</span>
                    ) : projectFolders && projectFolders.length === 0 ? (
                      <span>{t('mesh.folderScopesEmpty')}</span>
                    ) : projectFolders ? (
                      <ul className={styles.folderScopeList}>
                        {projectFolders.map((name) => {
                          const blocked = blockedFolders.has(name)
                          return (
                            <li key={name}>
                              <button
                                type="button"
                                className={`${styles.folderScopeItem} ${blocked ? styles.folderScopeItemBlocked : ''}`}
                                onClick={() => toggleBlockedFolder(name)}
                                aria-pressed={!blocked}
                              >
                                <span className={styles.folderScopeName}>{name}</span>
                                <span className={styles.folderScopeState}>
                                  {blocked
                                    ? t('mesh.folderScopeBlocked')
                                    : t('mesh.folderScopeIncluded')}
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    ) : (
                      <Loader2 size={13} className={styles.spin} />
                    )}
                    <label htmlFor="invite-expiry">{t('mesh.invitationExpiry')}</label>
                    <select
                      id="invite-expiry"
                      value={inviteExpiryId}
                      onChange={(event) => {
                        setInviteExpiryId(
                          event.target.value as (typeof INVITATION_EXPIRY_CHOICES_MS)[number]['id'],
                        )
                        setInviteConfirming(false)
                      }}
                    >
                      {INVITATION_EXPIRY_CHOICES_MS.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {t(`mesh.invitationExpiry.${choice.id}`)}
                        </option>
                      ))}
                    </select>
                    {inviteError ? (
                      <span className={styles.deviceActionError}>{t('mesh.inviteFailed')}</span>
                    ) : null}
                    <button
                      type="button"
                      className={styles.saveOAuthBtn}
                      disabled={inviteBusy || !recipientAccountId.trim()}
                      onClick={() => void submitInvite()}
                    >
                      {inviteConfirming
                        ? t('mesh.confirmSensitiveInvite')
                        : t('mesh.sendInvitation')}
                    </button>
                  </>
                )}
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

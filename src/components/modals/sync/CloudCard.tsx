import { Cloud, Github, Loader2, LogOut, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { saveFile } from '../../../lib/dialog'
import { useT } from '../../../lib/i18n'
import { checkRemoteChanges, type RemoteChanges, summarizeResult, syncNow } from '../../../lib/sync'
import { IMPLEMENTED_SCOPES, type ImplementedScope } from '../../../lib/sync/contract'
import { parseState } from '../../../lib/sync/engine'
import { notifyCloudStatusChanged } from '../../../lib/sync/events'
import {
  type CloudAccount,
  cloudBillingCheckout,
  cloudBillingPortal,
  cloudBillingRefresh,
  type CloudDevice,
  type CloudDeviceStart,
  type CloudRevision,
  cloudSyncDeleteAccount,
  cloudSyncDeviceFinish,
  cloudSyncDevices,
  cloudSyncDeviceStart,
  cloudSyncExportAccount,
  cloudSyncLogout,
  cloudSyncManifest,
  cloudSyncMe,
  cloudSyncPut,
  cloudSyncRevision,
  cloudSyncRevisions,
  cloudSyncRevokeDevice,
  cloudSyncStateRead,
  type CloudSyncStatus,
  cloudSyncStatus,
  openInBrowser,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import styles from '../SyncModal.module.css'
import { MachinesSection } from './MachinesSection'
import { formatWhen, summaryText, syncErrorText } from './syncText'

type Busy =
  | null
  | 'signin'
  | 'sync'
  | 'logout'
  | 'checkout'
  | 'portal'
  | 'refresh'
  | 'delete'
  | 'export'
  | 'restore'

type Feedback = { kind: 'error' | 'notice'; text: string } | null

const HISTORY_SCOPE_LABEL = {
  settings: 'sync.history.scope.settings',
  projects: 'sync.history.scope.projects',
  tooling: 'sync.history.scope.tooling',
} as const

export function CloudCard({ open }: { open: boolean }) {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const [status, setStatus] = useState<CloudSyncStatus | null>(null)
  const [account, setAccount] = useState<CloudAccount | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [deviceStart, setDeviceStart] = useState<CloudDeviceStart | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null)
  const [remote, setRemote] = useState<RemoteChanges | null>(null)
  const [devices, setDevices] = useState<CloudDevice[] | null>(null)
  const [historyScope, setHistoryScope] = useState<ImplementedScope | null>(null)
  const [revisions, setRevisions] = useState<CloudRevision[] | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [awaitingCheckout, setAwaitingCheckout] = useState(false)

  const tRef = useRef(t)
  tRef.current = t
  const fail = useCallback(
    (error: unknown) => setFeedback({ kind: 'error', text: syncErrorText(tRef.current, error) }),
    [],
  )
  const note = useCallback((text: string) => setFeedback({ kind: 'notice', text }), [])

  const loadSyncState = useCallback(async () => {
    setLastSyncAt(parseState(await cloudSyncStateRead().catch(() => null)).lastSyncAt)
  }, [])

  const load = useCallback(async () => {
    const next = await cloudSyncStatus().catch(() => null)
    setStatus(next)
    if (!next?.connected) {
      setAccount(null)
      return
    }
    void loadSyncState()
    cloudSyncMe()
      .then(setAccount)
      .catch((error) => {
        fail(error)
        void cloudSyncStatus().then(setStatus)
      })
    checkRemoteChanges()
      .then(setRemote)
      .catch(() => setRemote(null))
  }, [loadSyncState, fail])

  useEffect(() => {
    if (!open) return
    setFeedback(null)
    setDeviceStart(null)
    setDevices(null)
    setHistoryScope(null)
    setRevisions(null)
    setConfirmDelete(false)
    setConfirmRestore(null)
    void load()
  }, [open, load])

  const refreshPlan = useCallback(async () => {
    setBusy('refresh')
    try {
      const result = await cloudBillingRefresh()
      if (result.plan === 'supporter') {
        setAwaitingCheckout(false)
        note(tRef.current('sync.supporter.thanks'))
        notifyCloudStatusChanged()
      }
      setAccount(await cloudSyncMe())
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }, [note, fail])

  useEffect(() => {
    if (!awaitingCheckout) return
    const onFocus = () => void refreshPlan()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [awaitingCheckout, refreshPlan])

  const runSync = async (afterSignIn = false) => {
    setBusy('sync')
    setFeedback(null)
    try {
      const result = await syncNow()
      const summary = summarizeResult(result)
      note(afterSignIn ? t('sync.cloud.signedInSynced') : summaryText(t, summary))
      setRemote(null)
      await loadSyncState()
    } catch (error) {
      fail(error)
      setStatus(await cloudSyncStatus().catch(() => null))
    } finally {
      setBusy(null)
    }
  }

  const signIn = async () => {
    setBusy('signin')
    setFeedback(null)
    try {
      const start = await cloudSyncDeviceStart()
      setDeviceStart(start)
      void openInBrowser(start.verification_uri)
      setStatus(await cloudSyncDeviceFinish(start))
      setDeviceStart(null)
      notifyCloudStatusChanged()
      setAccount(await cloudSyncMe().catch(() => null))
      await runSync(true)
    } catch (error) {
      fail(error)
    } finally {
      setDeviceStart(null)
      setBusy(null)
    }
  }

  const signOut = async () => {
    setBusy('logout')
    setFeedback(null)
    try {
      setStatus(await cloudSyncLogout())
      setAccount(null)
      setDevices(null)
      notifyCloudStatusChanged()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const checkout = async (interval: 'month' | 'year') => {
    setBusy('checkout')
    setFeedback(null)
    try {
      await openInBrowser(await cloudBillingCheckout(interval))
      setAwaitingCheckout(true)
      note(t('sync.supporter.waiting'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const manage = async () => {
    setBusy('portal')
    try {
      await openInBrowser(await cloudBillingPortal())
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const toggleDevices = async () => {
    if (devices) {
      setDevices(null)
      return
    }
    try {
      setDevices(await cloudSyncDevices())
    } catch (error) {
      fail(error)
    }
  }

  const revoke = async (id: string) => {
    try {
      await cloudSyncRevokeDevice(id)
      setDevices(await cloudSyncDevices())
    } catch (error) {
      fail(error)
    }
  }

  const showHistory = async (scope: ImplementedScope) => {
    setHistoryScope(scope)
    setRevisions(null)
    setConfirmRestore(null)
    try {
      setRevisions(await cloudSyncRevisions(scope))
    } catch (error) {
      fail(error)
    }
  }

  const restore = async (version: number) => {
    if (!historyScope) return
    setConfirmRestore(null)
    setBusy('restore')
    setFeedback(null)
    try {
      const [revision, manifest] = await Promise.all([
        cloudSyncRevision(historyScope, version),
        cloudSyncManifest(),
      ])
      const current = manifest.scopes[historyScope]?.version ?? 0
      const outcome = await cloudSyncPut(historyScope, revision.payload, current)
      if (outcome.kind === 'conflict') throw new Error('conflict_retry_exhausted')
      await syncNow([historyScope])
      await loadSyncState()
      setRevisions(await cloudSyncRevisions(historyScope))
      note(t('sync.history.restored', { version }))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const exportAccount = async () => {
    const target = await saveFile({
      title: t('sync.account.export'),
      defaultPath: 'alethe-cloud-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!target) return
    setBusy('export')
    try {
      await cloudSyncExportAccount(target)
      note(t('sync.account.exportDone'))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const deleteAccount = async () => {
    setConfirmDelete(false)
    setBusy('delete')
    setFeedback(null)
    try {
      setStatus(await cloudSyncDeleteAccount())
      setAccount(null)
      note(t('sync.account.deleted'))
      notifyCloudStatusChanged()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const plan = account?.plan ?? status?.plan ?? 'free'
  const supporter = plan === 'supporter'
  const periodEnd = account?.entitlement?.currentPeriodEnd ?? null
  const canceled = account?.entitlement?.status === 'canceled'

  return (
    <section className={`${styles.card} ${styles.cardWide}`}>
      <header className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Cloud size={18} />
        </span>
        <div className={styles.cardTitleWrap}>
          <div className={styles.cloudTitleRow}>
            <h3 className={styles.cardTitle}>{t('sync.cloud.title')}</h3>
            {status?.connected ? (
              <span className={supporter ? styles.badgeAccent : styles.badge}>
                {supporter ? t('sync.cloud.planSupporter') : t('sync.cloud.planFree')}
              </span>
            ) : null}
          </div>
          {status?.connected ? (
            <span className={styles.connected}>
              <span className={styles.dot} />
              {t('sync.cloud.connectedAs', { login: status.login ?? '—' })}
            </span>
          ) : (
            <p className={styles.cardDesc}>{t('sync.cloud.freeDesc')}</p>
          )}
        </div>
      </header>

      {!status?.connected ? (
        deviceStart ? (
          <div className={styles.deviceFlow}>
            <p className={styles.hint}>{t('sync.cloud.codeHint')}</p>
            <span className={styles.deviceCode}>{deviceStart.user_code}</span>
            <button
              type="button"
              className={styles.link}
              onClick={() => void openInBrowser(deviceStart.verification_uri)}
            >
              {t('sync.cloud.openGithub')}
            </button>
            <p className={styles.hint}>{t('sync.cloud.waiting')}</p>
          </div>
        ) : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy !== null}
              onClick={signIn}
            >
              {busy === 'signin' ? (
                <Loader2 size={14} className={styles.spin} />
              ) : (
                <Github size={14} />
              )}
              {busy === 'signin' ? t('sync.cloud.waiting') : t('sync.cloud.signIn')}
            </button>
          </div>
        )
      ) : (
        <>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy !== null}
              onClick={() => void runSync()}
            >
              {busy === 'sync' ? (
                <Loader2 size={14} className={styles.spin} />
              ) : (
                <RefreshCw size={14} />
              )}
              {busy === 'sync' ? t('sync.cloud.syncing') : t('sync.cloud.syncNow')}
            </button>
          </div>
          <div className={styles.meta}>
            <span>
              {lastSyncAt
                ? t('sync.cloud.lastSync', { when: formatWhen(t, language, lastSyncAt) })
                : t('sync.cloud.neverSynced')}
            </span>
            {remote && remote.scopes.length > 0 ? (
              <span className={styles.metaStrong}>
                {remote.devices.length
                  ? t('sync.cloud.remoteChanges', { devices: remote.devices.join(', ') })
                  : t('sync.toast.remoteBody')}
              </span>
            ) : null}
            {supporter ? <span>{t('sync.cloud.autoOn')}</span> : null}
          </div>

          <MachinesSection open={open} refreshKey={lastSyncAt} onNotice={note} onError={fail} />

          {supporter ? (
            <div className={styles.panel}>
              <p className={styles.panelText}>
                {t('sync.supporter.thanks')}{' '}
                {periodEnd
                  ? canceled
                    ? t('sync.supporter.ends', { when: formatWhen(t, language, periodEnd) })
                    : t('sync.supporter.renews', { when: formatWhen(t, language, periodEnd) })
                  : null}
              </p>
              {account?.entitlement?.source === 'polar' ? (
                <button
                  type="button"
                  className={styles.link}
                  disabled={busy !== null}
                  onClick={manage}
                >
                  {t('sync.supporter.manage')}
                </button>
              ) : null}
            </div>
          ) : (
            <div className={styles.panel}>
              <h4 className={styles.panelTitle}>{t('sync.supporter.title')}</h4>
              <p className={styles.panelText}>{t('sync.supporter.desc')}</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={busy !== null}
                  onClick={() => void checkout('year')}
                >
                  {t('sync.supporter.yearly')}
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy !== null}
                  onClick={() => void checkout('month')}
                >
                  {t('sync.supporter.monthly')}
                </button>
              </div>
              {awaitingCheckout ? (
                <button
                  type="button"
                  className={styles.link}
                  disabled={busy !== null}
                  onClick={() => void refreshPlan()}
                >
                  {busy === 'refresh' ? t('sync.cloud.syncing') : t('sync.supporter.refresh')}
                </button>
              ) : null}
            </div>
          )}

          <div className={styles.section}>
            <button type="button" className={styles.sectionToggle} onClick={toggleDevices}>
              {t('sync.devices.title')}
            </button>
            {devices ? (
              <ul className={styles.list}>
                {devices.map((device) => (
                  <li key={device.id} className={styles.listRow}>
                    <span className={styles.listMain}>
                      {device.name}
                      {device.current ? (
                        <span className={styles.badge}>{t('sync.devices.thisDevice')}</span>
                      ) : null}
                    </span>
                    <span className={styles.listMeta}>
                      {t('sync.devices.lastSeen', {
                        when: formatWhen(t, language, device.lastSeenAt),
                      })}
                    </span>
                    {!device.current ? (
                      <button
                        type="button"
                        className={styles.linkDanger}
                        onClick={() => void revoke(device.id)}
                      >
                        {t('sync.devices.revoke')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionRow}>
              <span className={styles.sectionLabel}>{t('sync.history.title')}</span>
              {IMPLEMENTED_SCOPES.map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className={historyScope === scope ? styles.chipActive : styles.chip}
                  onClick={() => void showHistory(scope)}
                >
                  {t(HISTORY_SCOPE_LABEL[scope])}
                </button>
              ))}
            </div>
            {historyScope && revisions ? (
              revisions.length === 0 ? (
                <p className={styles.hint}>{t('sync.history.empty')}</p>
              ) : (
                <ul className={styles.list}>
                  {revisions.map((revision) => (
                    <li key={revision.version} className={styles.listRow}>
                      <span className={styles.listMain}>
                        {t('sync.history.entry', {
                          version: revision.version,
                          when: formatWhen(t, language, revision.createdAt),
                          device: revision.device?.name ?? '—',
                        })}
                      </span>
                      {confirmRestore === revision.version ? (
                        <span className={styles.inlineConfirm}>
                          <button
                            type="button"
                            className={styles.link}
                            onClick={() => setConfirmRestore(null)}
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            type="button"
                            className={styles.linkDanger}
                            disabled={busy !== null}
                            onClick={() => void restore(revision.version)}
                          >
                            {t('sync.history.restore')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={styles.link}
                          disabled={busy !== null}
                          onClick={() => setConfirmRestore(revision.version)}
                        >
                          {t('sync.history.restore')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            {confirmRestore !== null ? (
              <p className={styles.hint}>
                {t('sync.history.confirmRestore', { version: confirmRestore })}
              </p>
            ) : null}
          </div>

          {confirmDelete ? (
            <div className={styles.confirm}>
              <p>{t('sync.account.confirmDelete')}</p>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.btnGhost}
                  onClick={() => setConfirmDelete(false)}
                >
                  {t('common.cancel')}
                </button>
                <button type="button" className={styles.btnDanger} onClick={deleteAccount}>
                  {t('sync.account.delete')}
                </button>
              </div>
            </div>
          ) : null}

          <div className={styles.cardFooter}>
            <button
              type="button"
              className={styles.link}
              disabled={busy !== null}
              onClick={exportAccount}
            >
              {t('sync.account.export')}
            </button>
            <button
              type="button"
              className={styles.link}
              disabled={busy !== null}
              onClick={() => setConfirmDelete(true)}
            >
              {t('sync.account.delete')}
            </button>
            <button
              type="button"
              className={styles.linkDanger}
              disabled={busy !== null}
              onClick={signOut}
            >
              <LogOut size={12} />
              {t('sync.account.signOut')}
            </button>
          </div>
        </>
      )}

      {feedback ? (
        <p className={feedback.kind === 'error' ? styles.error : styles.notice}>{feedback.text}</p>
      ) : null}
    </section>
  )
}

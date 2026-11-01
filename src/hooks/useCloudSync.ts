import { useEffect } from 'react'

import { getLocale, translate } from '../lib/i18n'
import { checkRemoteChanges, isSyncRunning, summarizeResult, syncNow } from '../lib/sync'
import { onCloudStatusChanged } from '../lib/sync/events'
import { syncedFingerprint } from '../lib/sync/fingerprint'
import { cloudSyncMe, type CloudSyncStatus, cloudSyncStatus } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

const CHANGE_DEBOUNCE_MS = 4_000
const FOCUS_THROTTLE_MS = 60_000
const POLL_INTERVAL_MS = 5 * 60_000

function currentFingerprint(): string {
  const { preferences, projects } = useProjectsStore.getState()
  return syncedFingerprint(preferences, projects)
}

function offerRemoteChanges(devices: string[]): void {
  const locale = getLocale()
  useUiStore.getState().pushToast({
    title: translate(locale, 'sync.toast.remoteTitle'),
    body: devices.length
      ? translate(locale, 'sync.cloud.remoteChanges', { devices: devices.join(', ') })
      : translate(locale, 'sync.toast.remoteBody'),
    actions: [
      {
        label: translate(locale, 'sync.cloud.syncNow'),
        run: () => {
          void syncNow().then(
            (result) => {
              const { available } = summarizeResult(result)
              if (available > 0) offerAvailableProjects(available)
              else
                useUiStore
                  .getState()
                  .pushToast({ title: translate(locale, 'sync.toast.synced'), body: '' })
            },
            (error: unknown) =>
              useUiStore.getState().pushToast({
                title: translate(locale, 'sync.toast.failed'),
                body: String(error),
              }),
          )
        },
      },
    ],
  })
}

function offerAvailableProjects(count: number): void {
  const locale = getLocale()
  useUiStore.getState().pushToast({
    title: translate(locale, 'sync.toast.availableTitle'),
    body: translate(locale, 'sync.toast.availableBody', { count }),
    actions: [
      {
        label: translate(locale, 'sync.toast.show'),
        run: () => useUiStore.getState().openModal_('sync'),
      },
    ],
  })
}

export function useCloudSync(hydrated: boolean, profileId: string | null): void {
  useEffect(() => {
    if (!hydrated) return
    let disposed = false
    let status: CloudSyncStatus | null = null
    let lastFingerprint = currentFingerprint()
    let lastRun = 0
    let debounce: ReturnType<typeof setTimeout> | undefined

    const automatic = () => !!status?.connected && status.plan === 'supporter'

    const run = async () => {
      if (disposed || !automatic() || isSyncRunning()) return
      lastRun = Date.now()
      try {
        const { available } = summarizeResult(await syncNow())
        lastFingerprint = currentFingerprint()
        if (available > 0 && !disposed) offerAvailableProjects(available)
      } catch (error) {
        const message = String((error as { message?: string })?.message ?? error)
        if (message === 'session_expired' || message === 'not_connected') status = null
      }
    }

    const refresh = async (initial: boolean) => {
      status = await cloudSyncStatus().catch(() => null)
      if (disposed || !status?.connected) return
      const account = await cloudSyncMe().catch(() => null)
      if (account) status = { ...status, plan: account.plan }
      if (disposed || !initial) return
      if (automatic()) {
        await run()
        return
      }
      const changes = await checkRemoteChanges().catch(() => null)
      if (!disposed && changes && changes.scopes.length > 0) offerRemoteChanges(changes.devices)
    }

    const unsubscribeStore = useProjectsStore.subscribe((state, prev) => {
      if (!automatic()) return
      if (state.preferences === prev.preferences && state.projects === prev.projects) return
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (isSyncRunning() || currentFingerprint() === lastFingerprint) return
        void run()
      }, CHANGE_DEBOUNCE_MS)
    })

    const onFocus = () => {
      if (Date.now() - lastRun > FOCUS_THROTTLE_MS) void run()
    }
    window.addEventListener('focus', onFocus)
    const poll = setInterval(() => {
      if (document.hasFocus()) void run()
    }, POLL_INTERVAL_MS)
    const unsubscribeStatus = onCloudStatusChanged(() => void refresh(false))

    void refresh(true)

    return () => {
      disposed = true
      clearTimeout(debounce)
      clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      unsubscribeStore()
      unsubscribeStatus()
    }
  }, [hydrated, profileId])
}

import { Download, ExternalLink, Play, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { useRouter9Runtime } from '../../hooks/useRouter9Runtime'
import { useT } from '../../lib/i18n'
import { normalizePort, ROUTER9_ADVISORIES_URL, router9BaseUrl } from '../../lib/router9'
import { openInBrowser } from '../../lib/tauri'
import type { Router9Preferences } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import controls from '../modals/controls.module.css'
import { SettingsSection } from '../modals/preferences/primitives'
import { Router9InstallModal } from './Router9InstallModal'
import styles from './Router9Settings.module.css'

type Notice = { key: string; text: string; tone: 'warn' | 'info' }

export function Router9Settings() {
  const t = useT()
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const { config, status, toolchain, resolved, hasInstall, busy, refresh, start, stop } =
    useRouter9Runtime()
  const [error, setError] = useState<string | null>(null)
  const [installAction, setInstallAction] = useState<'install' | 'uninstall' | null>(null)

  const patch = (next: Partial<Router9Preferences>) => {
    setPreferences({ router9: { ...config, ...next } })
  }

  const act = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const managed = status?.managed
  const external = status?.external
  const running = Boolean(status?.running)
  const npmReady = toolchain?.npm === true
  const probing = status === null || toolchain === null

  const state = !config.enabled ? 'off' : running ? 'running' : 'ready'
  const stateLabel =
    state === 'running'
      ? t('router9.stateRunning', { url: router9BaseUrl(config.port) })
      : state === 'ready'
        ? t('router9.stateReady')
        : t('router9.stateOff')

  const notices: Notice[] = []
  if (toolchain !== null && !npmReady) {
    notices.push({ key: 'node', text: t('router9.nodeMissing'), tone: 'warn' })
  }
  if (resolved && resolved.source !== config.source) {
    notices.push({
      key: 'fallback',
      text: t(resolved.source === 'external' ? 'router9.fallbackExternal' : 'router9.fallbackManaged'),
      tone: 'warn',
    })
  }
  if (config.enabled && !config.apiKey.trim()) {
    notices.push({ key: 'key', text: t('router9.missingKey'), tone: 'warn' })
  }
  if (status && status.portInUse && !running) {
    notices.push({
      key: 'port',
      text: t('router9.portInUse', { port: String(status.port) }),
      tone: 'warn',
    })
  }
  if (
    managed?.installed &&
    managed.version &&
    status &&
    managed.version !== status.pinnedVersion
  ) {
    notices.push({ key: 'pinned', text: t('router9.pinnedMismatch'), tone: 'info' })
  }
  // Only worth saying once it can actually bite: routing is on and agents may already be attached.
  if (config.enabled && running) {
    notices.push({ key: 'restart', text: t('router9.runningTerminalsHint'), tone: 'info' })
  }
  if (error) notices.push({ key: 'error', text: error, tone: 'warn' })

  return (
    <SettingsSection id="router9" title={t('router9.title')} description={t('router9.desc')}>
      <div className={styles.root}>
        <div className={styles.statusBar}>
          <span className={styles.state} data-state={state}>
            <span className={styles.dot} aria-hidden />
            {probing ? t('router9.probing') : stateLabel}
          </span>
          {hasInstall && config.enabled ? (
            <div className={styles.statusActions}>
              <button
                type="button"
                className={styles.quietBtn}
                disabled={busy}
                onClick={() => void act(() => (running ? stop() : start()))}
              >
                {running ? <Square size={12} /> : <Play size={12} />}
                {running ? t('router9.stop') : t('router9.start')}
              </button>
              <button
                type="button"
                className={styles.quietBtn}
                disabled={!running}
                onClick={() => void openInBrowser(status?.dashboardUrl ?? '').catch(() => undefined)}
              >
                <ExternalLink size={12} />
                {t('router9.dashboard')}
              </button>
            </div>
          ) : null}
        </div>

        {!probing && !hasInstall ? (
          <div className={styles.setup}>
            <p className={styles.setupCopy}>{t('router9.setupIntro')}</p>
            <div className={styles.row}>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                onClick={() => setInstallAction('install')}
              >
                <Download size={13} />
                {t('router9.installForMe')}
              </button>
            </div>
          </div>
        ) : null}

        {hasInstall ? (
          <>
            <div className={styles.installRow}>
              <div className={styles.installCopy}>
                <strong>
                  {resolved?.source === 'external'
                    ? t('router9.sourceExternal')
                    : t('router9.sourceManaged')}
                </strong>
                <small>
                  {resolved?.source === 'external'
                    ? t('router9.externalInstalled', {
                        version: external?.version ?? '?',
                        path: external?.path ?? '',
                      })
                    : t('router9.managedInstalled', { version: managed?.version ?? '?' })}
                </small>
              </div>
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.quietBtn}
                  disabled={!npmReady}
                  onClick={() => setInstallAction('install')}
                >
                  <Download size={12} />
                  {managed?.installed ? t('router9.update', { version: status?.pinnedVersion ?? '' }) : t('router9.install')}
                </button>
                {managed?.installed ? (
                  <button
                    type="button"
                    className={`${styles.quietBtn} ${styles.dangerBtn}`}
                    disabled={busy}
                    onClick={() => setInstallAction('uninstall')}
                  >
                    <Trash2 size={12} />
                    {t('router9.uninstallManaged')}
                  </button>
                ) : null}
              </div>
            </div>

            {external?.installed && managed?.installed ? (
              <label className={styles.field}>
                <span>{t('router9.sourceLabel')}</span>
                <div className={styles.segmented}>
                  <button
                    type="button"
                    className={config.source === 'managed' ? styles.segmentActive : undefined}
                    onClick={() => patch({ source: 'managed' })}
                  >
                    {t('router9.sourceManaged')}
                  </button>
                  <button
                    type="button"
                    className={config.source === 'external' ? styles.segmentActive : undefined}
                    onClick={() => patch({ source: 'external' })}
                  >
                    {t('router9.sourceExternal')}
                  </button>
                </div>
              </label>
            ) : null}

            <label className={styles.field}>
              <span>{t('router9.enabled')}</span>
              <div className={styles.segmented}>
                <button
                  type="button"
                  className={config.enabled ? styles.segmentActive : undefined}
                  onClick={() => patch({ enabled: true })}
                >
                  {t('router9.enabledOn')}
                </button>
                <button
                  type="button"
                  className={!config.enabled ? styles.segmentActive : undefined}
                  onClick={() =>
                    void act(async () => {
                      patch({ enabled: false })
                      await stop()
                    })
                  }
                >
                  {t('router9.enabledOff')}
                </button>
              </div>
            </label>

            {config.enabled ? (
              <div className={styles.connection}>
                <div className={styles.connectionGrid}>
                  <label className={styles.field}>
                    <span>{t('router9.apiKey')}</span>
                    <input
                      className={controls.input}
                      type="password"
                      value={config.apiKey}
                      placeholder="9r_..."
                      spellCheck={false}
                      onChange={(event) => patch({ apiKey: event.target.value })}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>{t('router9.port')}</span>
                    <input
                      className={controls.input}
                      type="number"
                      value={config.port}
                      onChange={(event) => patch({ port: normalizePort(Number(event.target.value)) })}
                    />
                  </label>
                </div>
                <p className={styles.hint}>{t('router9.apiKeyHint')}</p>

                <label className={styles.field}>
                  <span>{t('router9.autoStart')}</span>
                  <div className={styles.segmented}>
                    <button
                      type="button"
                      className={config.autoStart ? styles.segmentActive : undefined}
                      onClick={() => patch({ autoStart: true })}
                    >
                      {t('router9.autoStartOn')}
                    </button>
                    <button
                      type="button"
                      className={!config.autoStart ? styles.segmentActive : undefined}
                      onClick={() => patch({ autoStart: false })}
                    >
                      {t('router9.autoStartOff')}
                    </button>
                  </div>
                </label>
              </div>
            ) : null}
          </>
        ) : null}

        {notices.length > 0 ? (
          <ul className={styles.notices}>
            {notices.map((notice) => (
              <li key={notice.key} className={styles.notice} data-tone={notice.tone}>
                {notice.text}
              </li>
            ))}
          </ul>
        ) : null}

        <div className={styles.footer}>
          <p className={styles.hint}>{t('router9.securityNote')}</p>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => void openInBrowser(ROUTER9_ADVISORIES_URL).catch(() => undefined)}
          >
            <ExternalLink size={12} />
            {t('router9.securityAdvisories')}
          </button>
        </div>
      </div>

      <Router9InstallModal
        action={installAction ?? 'install'}
        open={installAction !== null}
        onClose={() => setInstallAction(null)}
        onSettled={() => void refresh()}
        nested
      />
    </SettingsSection>
  )
}

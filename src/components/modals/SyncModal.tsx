import { Cloud, Download, Github, Heart, Loader2, LogOut, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'

import { intlLocale, type MessageKey, useT } from '../../lib/i18n'
import {
  githubSyncLogout,
  githubSyncPull,
  githubSyncPush,
  githubSyncSetToken,
  githubSyncStatus,
  openInBrowser,
  type GithubSyncStatus,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import styles from './SyncModal.module.css'

const SPONSOR_URL = 'https://github.com/sponsors/Kc1t'
const CREATE_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=gist&description=Alethe%20Sync'

type Busy = null | 'connect' | 'push' | 'pull' | 'logout'

                                                                            
                                                         
const KNOWN_ERRORS = new Set([
  'empty_token',
  'invalid_token',
  'not_connected',
  'no_remote',
  'nothing_to_sync',
  'remote_missing_projects',
])

export function SyncModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'sync')
  const closeModal = useUiStore((s) => s.closeModal)
  const language = useProjectsStore((s) => s.preferences.language)
  const hydrate = useProjectsStore((s) => s.hydrate)

  const [status, setStatus] = useState<GithubSyncStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmPull, setConfirmPull] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setNotice(null)
    setConfirmPull(false)
    setToken('')
    githubSyncStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [open])

  const connected = status?.connected ?? false

  const formatWhen = (ms: number | null | undefined): string => {
    if (!ms) return t('sync.github.never')
    try {
      return new Date(ms).toLocaleString(intlLocale(language))
    } catch {
      return new Date(ms).toLocaleString()
    }
  }

  const mapError = (raw: unknown): string => {
    const msg =
      typeof raw === 'string' ? raw : String((raw as { message?: string })?.message ?? raw)
    if (KNOWN_ERRORS.has(msg)) return t(`sync.error.${msg}` as MessageKey)
    return t('sync.error.generic', { error: msg })
  }

  const onConnect = async () => {
    const value = token.trim()
    if (!value) {
      setError(t('sync.error.empty_token'))
      return
    }
    setBusy('connect')
    setError(null)
    setNotice(null)
    try {
      const next = await githubSyncSetToken(value)
      setStatus(next)
      setToken('')
    } catch (e) {
      setError(mapError(e))
    } finally {
      setBusy(null)
    }
  }

  const onPush = async () => {
    setBusy('push')
    setError(null)
    setNotice(null)
    try {
      const next = await githubSyncPush()
      setStatus(next)
      setNotice(t('sync.github.pushDone'))
    } catch (e) {
      setError(mapError(e))
    } finally {
      setBusy(null)
    }
  }

  const onPull = async () => {
    setConfirmPull(false)
    setBusy('pull')
    setError(null)
    setNotice(null)
    try {
      const next = await githubSyncPull()
      setStatus(next)
      // Regrava projects.json/activity-stats.json em disco → re-hidrata o store
                                          
      await hydrate()
      setNotice(t('sync.github.pullDone'))
    } catch (e) {
      setError(mapError(e))
    } finally {
      setBusy(null)
    }
  }

  const onLogout = async () => {
    setBusy('logout')
    setError(null)
    setNotice(null)
    try {
      const next = await githubSyncLogout()
      setStatus(next)
      setConfirmPull(false)
    } catch (e) {
      setError(mapError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal open={open} onClose={closeModal} title={t('sync.title')} width={580}>
      <p className={styles.subtitle}>{t('sync.subtitle')}</p>

      <div className={styles.grid}>
        {/* ---- GitHub (funcional) ---- */}
        <section className={styles.card}>
          <header className={styles.cardHead}>
            <span className={styles.cardIcon}>
              <Github size={18} />
            </span>
            <div className={styles.cardTitleWrap}>
              <h3 className={styles.cardTitle}>{t('sync.github.title')}</h3>
              {connected ? (
                <span className={styles.connected}>
                  <span className={styles.dot} />
                  {t('sync.github.connectedAs', { login: status?.login ?? '—' })}
                </span>
              ) : (
                <p className={styles.cardDesc}>{t('sync.github.desc')}</p>
              )}
            </div>
          </header>

          {connected ? (
            <>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy !== null}
                  onClick={onPush}
                >
                  {busy === 'push' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <Upload size={14} />
                  )}
                  {busy === 'push' ? t('sync.github.pushing') : t('sync.github.push')}
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy !== null}
                  onClick={() => setConfirmPull(true)}
                >
                  {busy === 'pull' ? (
                    <Loader2 size={14} className={styles.spin} />
                  ) : (
                    <Download size={14} />
                  )}
                  {busy === 'pull' ? t('sync.github.pulling') : t('sync.github.pull')}
                </button>
              </div>

              {confirmPull ? (
                <div className={styles.confirm}>
                  <p>{t('sync.github.confirmPull')}</p>
                  <div className={styles.confirmActions}>
                    <button
                      type="button"
                      className={styles.btnGhost}
                      onClick={() => setConfirmPull(false)}
                    >
                      {t('common.cancel')}
                    </button>
                    <button type="button" className={styles.btnPrimary} onClick={onPull}>
                      {t('sync.github.pull')}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className={styles.meta}>
                <span>{t('sync.github.lastPush', { when: formatWhen(status?.last_push_ms) })}</span>
                <span>{t('sync.github.lastPull', { when: formatWhen(status?.last_pull_ms) })}</span>
              </div>

              <div className={styles.cardFooter}>
                {status?.gist_url ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => void openInBrowser(status.gist_url!)}
                  >
                    {t('sync.github.openGist')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.linkDanger}
                  disabled={busy !== null}
                  onClick={onLogout}
                >
                  <LogOut size={12} />
                  {t('sync.github.disconnect')}
                </button>
              </div>
            </>
          ) : (
            <div className={styles.connectForm}>
              <input
                className={styles.input}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('sync.github.tokenPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onConnect()
                }}
              />
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={busy !== null || !token.trim()}
                onClick={onConnect}
              >
                {busy === 'connect' ? <Loader2 size={14} className={styles.spin} /> : null}
                {busy === 'connect' ? t('sync.github.connecting') : t('sync.github.connect')}
              </button>
              <p className={styles.hint}>
                {t('sync.github.tokenHint')}{' '}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void openInBrowser(CREATE_TOKEN_URL)}
                >
                  {t('sync.github.createToken')}
                </button>
              </p>
            </div>
          )}
        </section>

        {/* ---- Nuvem (em breve / premium) ---- */}
        <section className={`${styles.card} ${styles.cardSoon}`}>
          <header className={styles.cardHead}>
            <span className={styles.cardIcon}>
              <Cloud size={18} />
            </span>
            <div className={styles.cardTitleWrap}>
              <div className={styles.cloudTitleRow}>
                <h3 className={styles.cardTitle}>{t('sync.cloud.title')}</h3>
                <span className={styles.badge}>{t('sync.cloud.soon')}</span>
              </div>
              <p className={styles.cardDesc}>{t('sync.cloud.desc')}</p>
            </div>
          </header>
          <div className={styles.cloudFoot}>
            <span className={styles.premium}>{t('sync.cloud.premium')}</span>
            <button type="button" className={styles.btn} disabled>
              {t('sync.cloud.cta')}
            </button>
          </div>
        </section>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
      {notice ? <p className={styles.notice}>{notice}</p> : null}

      <div className={styles.sponsorRow}>
        <button
          type="button"
          className={styles.sponsor}
          onClick={() => void openInBrowser(SPONSOR_URL)}
        >
          <Heart size={15} />
          {t('sync.sponsor')}
        </button>
      </div>
    </Modal>
  )
}

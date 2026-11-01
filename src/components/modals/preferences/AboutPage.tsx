import { getTauriVersion, getVersion } from '@tauri-apps/api/app'
import {
  BookOpen,
  Bug,
  Download,
  DownloadCloud,
  ExternalLink,
  FolderOpen,
  Github,
  GitPullRequest,
  History,
  Instagram,
  Lightbulb,
  Linkedin,
  type LucideIcon,
  RotateCcw,
  ScrollText,
  TriangleAlert,
  Youtube,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import creatorPhoto from '../../../assets/creator-kaua-miguel.jpg'
import { announceBackup, exportProfileState } from '../../../lib/backup'
import { CURRENT_VERSION, formatReleaseDate } from '../../../lib/changelogData'
import { saveFile } from '../../../lib/dialog'
import { getLocale, intlLocale, useT } from '../../../lib/i18n'
import {
  type AletheRelease,
  ALL_RELEASES_URL,
  fetchAletheReleases,
  olderReleases,
  releasePageUrl,
} from '../../../lib/releases'
import { openDataFolder, openInBrowser, openLogsFolder } from '../../../lib/tauri/filesystem'
import { checkForUpdate, installPendingUpdate, installRelease } from '../../../lib/updater'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import about from './AboutPage.module.css'
import { SettingsSection } from './primitives'

const REPO_URL = 'https://github.com/Kc1t/alethe-agents'

const CREATOR_LINKS: { label: string; url: string; Icon: LucideIcon }[] = [
  { label: 'GitHub', url: 'https://github.com/Kc1t', Icon: Github },
  { label: 'YouTube', url: 'https://www.youtube.com/@kc_1t', Icon: Youtube },
  { label: 'Instagram', url: 'https://www.instagram.com/kc1t_dev', Icon: Instagram },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/in/kaua-miguel', Icon: Linkedin },
]

const smallButton = `${controls.btn} ${controls.btnSm}`

function percentOf(downloaded: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0
}

function LinkButton({ Icon, label, url }: { Icon: LucideIcon; label: string; url: string }) {
  return (
    <button type="button" className={smallButton} onClick={() => void openInBrowser(url)}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </button>
  )
}

export function AboutPage() {
  const [version, setVersion] = useState('')

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(''))
  }, [])

  return (
    <>
      <VersionSection version={version} />
      <CreatorSection />
      <UpdatesSection version={version} />
      <OlderVersionsSection version={version} />
      <ContributeSection />
      <InfoSection />
    </>
  )
}

function VersionSection({ version }: { version: string }) {
  const t = useT()
  const openModal = useUiStore((state) => state.openModal_)
  const [tauriVersion, setTauriVersion] = useState('')

  useEffect(() => {
    void getTauriVersion()
      .then(setTauriVersion)
      .catch(() => setTauriVersion(''))
  }, [])

  return (
    <SettingsSection
      id="app-version"
      title={t('prefs.aboutVersionTitle')}
      description={t('prefs.aboutVersionDesc')}
    >
      <div className={about.stack}>
        <div className={styles.versionCard}>
          <div className={about.identity}>
            <span className={about.appMark} aria-hidden="true" />
            <div className={styles.versionCardCopy}>
              <strong>Alethe</strong>
              <span>
                {tauriVersion ? `com.kc1t.alethe · Tauri ${tauriVersion}` : 'com.kc1t.alethe'}
              </span>
            </div>
          </div>
          <span className={styles.versionCardNumber}>{version ? `v${version}` : '—'}</span>
        </div>
        <button
          type="button"
          className={`${smallButton} ${styles.alignStart}`}
          onClick={() => openModal('whatsNew')}
        >
          <ScrollText size={13} aria-hidden="true" />
          {t('prefs.aboutWhatsNew')}
        </button>
      </div>
    </SettingsSection>
  )
}

function CreatorSection() {
  const t = useT()
  return (
    <SettingsSection
      id="app-creator"
      title={t('prefs.aboutCreatorTitle')}
      description={t('prefs.aboutCreatorDesc')}
    >
      <div className={about.stack}>
        <div className={about.creatorCard}>
          <img
            src={creatorPhoto}
            alt={t('prefs.aboutCreatorPhotoAlt')}
            className={about.creatorPhoto}
            draggable={false}
          />
          <div className={about.creatorCopy}>
            <strong>Kauã Miguel</strong>
            <span>@kc1t_dev · {t('prefs.aboutCreatorRole')}</span>
            <p>{t('prefs.aboutCreatorBio')}</p>
          </div>
        </div>
        <div className={about.linkRow}>
          {CREATOR_LINKS.map((link) => (
            <LinkButton key={link.label} {...link} />
          ))}
        </div>
      </div>
    </SettingsSection>
  )
}

function UpdatesSection({ version }: { version: string }) {
  const t = useT()
  const updateInfo = useUiStore((state) => state.updateInfo)
  const setUpdateInfo = useUiStore((state) => state.setUpdateInfo)
  const [checking, setChecking] = useState(false)
  const [checkedUpToDate, setCheckedUpToDate] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')

  const onCheck = async () => {
    if (checking) return
    setChecking(true)
    setCheckedUpToDate(false)
    setError('')
    try {
      const info = await checkForUpdate()
      setUpdateInfo(info)
      if (!info) setCheckedUpToDate(true)
    } catch (err) {
      setError(String(err))
    } finally {
      setChecking(false)
    }
  }

  const onInstall = async () => {
    setPhase('installing')
    setError('')
    try {
      await installPendingUpdate(({ downloaded, total }) =>
        setPercent(percentOf(downloaded, total)),
      )
    } catch (err) {
      setPhase('error')
      setError(String(err))
    }
  }

  const installing = phase === 'installing'

  return (
    <SettingsSection
      id="app-updates"
      title={t('prefs.aboutUpdatesTitle')}
      description={t('prefs.aboutUpdatesDesc')}
    >
      {updateInfo ? (
        <div className={styles.updateBlock}>
          <div className={styles.updateAvailable}>
            <DownloadCloud size={16} />
            <span>
              {t('prefs.aboutUpdateAvailable', {
                version: updateInfo.version,
                current: updateInfo.currentVersion,
              })}
            </span>
          </div>
          {updateInfo.notes ? <div className={styles.updateNotes}>{updateInfo.notes}</div> : null}
          {installing ? (
            <div className={styles.updateProgress} aria-hidden>
              <div className={styles.updateProgressBar} style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary} ${styles.alignStart}`}
            onClick={() => void onInstall()}
            disabled={installing}
          >
            {installing ? t('update.installing', { percent }) : t('update.installNow')}
          </button>
        </div>
      ) : (
        <div className={styles.updateBlock}>
          <button
            type="button"
            className={`${styles.secondaryButton} ${styles.alignStart}`}
            onClick={() => void onCheck()}
            disabled={checking}
          >
            <RotateCcw size={15} />
            {checking ? t('prefs.aboutChecking') : t('prefs.aboutCheckUpdates')}
          </button>
          {checkedUpToDate ? (
            <span className={styles.updateCheckedNote}>
              {t('prefs.aboutUpToDate', { version })}
            </span>
          ) : null}
        </div>
      )}
      {error ? <p className={styles.updateError}>{t('update.error', { error })}</p> : null}
    </SettingsSection>
  )
}

type ReleaseList =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; releases: AletheRelease[] }

function OlderVersionsSection({ version }: { version: string }) {
  const t = useT()
  const current = version || CURRENT_VERSION
  const [list, setList] = useState<ReleaseList>({ status: 'idle' })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [backup, setBackup] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [installing, setInstalling] = useState<{ version: string; percent: number } | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    setList({ status: 'loading' })
    try {
      setList({ status: 'ready', releases: olderReleases(await fetchAletheReleases(), current) })
    } catch (err) {
      setList({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  const onBackup = async () => {
    setError('')
    const target = await saveFile({
      title: t('menu.exportBackupTitle'),
      defaultPath: `alethe-backup-${new Date().toISOString().slice(0, 10)}.alethe.zip`,
      filters: [{ name: t('menu.backupFilter'), extensions: ['zip'] }],
    })
    if (!target) return
    setBackup('saving')
    try {
      announceBackup(await exportProfileState(target))
      setBackup('saved')
    } catch (err) {
      setBackup('idle')
      setError(t('prefs.aboutOlderBackupError', { error: String(err) }))
    }
  }

  const onInstall = async (target: string) => {
    setError('')
    setInstalling({ version: target, percent: 0 })
    try {
      await installRelease(target, ({ downloaded, total }) =>
        setInstalling({ version: target, percent: percentOf(downloaded, total) }),
      )
    } catch (err) {
      setInstalling(null)
      const reason = String(err)
      setError(
        reason.includes('release_not_installable')
          ? t('prefs.aboutOlderNotInstallable', { version: target })
          : t('prefs.aboutOlderInstallError', { version: target, error: reason }),
      )
    }
  }

  const ask = (target: string) => {
    setError('')
    setBackup('idle')
    setConfirming(target)
  }

  const locale = intlLocale(getLocale())

  return (
    <SettingsSection
      id="app-older-versions"
      title={t('prefs.aboutOlderTitle')}
      description={t('prefs.aboutOlderDesc')}
    >
      <div className={about.stack}>
        {list.status === 'ready' ? (
          list.releases.length === 0 ? (
            <p className={about.note}>{t('prefs.aboutOlderEmpty', { version: current })}</p>
          ) : (
            <ul className={about.releaseList}>
              {list.releases.map((release) => (
                <li key={release.version} className={about.releaseItem}>
                  <div className={about.releaseRow}>
                    <div className={about.releaseMeta}>
                      <span className={about.releaseVersion}>v{release.version}</span>
                      {release.publishedAt ? (
                        <span className={about.releaseDate}>
                          {formatReleaseDate(release.publishedAt, locale)}
                        </span>
                      ) : null}
                    </div>
                    {release.installable ? (
                      <button
                        type="button"
                        className={smallButton}
                        disabled={installing !== null}
                        onClick={() => ask(release.version)}
                      >
                        <History size={13} aria-hidden="true" />
                        {t('prefs.aboutOlderInstall')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={smallButton}
                        title={t('prefs.aboutOlderManualHint')}
                        onClick={() => void openInBrowser(releasePageUrl(release.version))}
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                        {t('prefs.aboutOlderDownload')}
                      </button>
                    )}
                  </div>
                  {confirming === release.version ? (
                    <div className={about.confirm}>
                      <p className={about.confirmText}>
                        <TriangleAlert size={15} aria-hidden="true" />
                        <span>{t('prefs.aboutOlderConfirm', { version: release.version })}</span>
                      </p>
                      {installing?.version === release.version ? (
                        <>
                          <div className={styles.updateProgress} aria-hidden="true">
                            <div
                              className={styles.updateProgressBar}
                              style={{ width: `${installing.percent}%` }}
                            />
                          </div>
                          <span className={about.note}>
                            {t('prefs.aboutOlderInstalling', {
                              version: release.version,
                              percent: installing.percent,
                            })}
                          </span>
                        </>
                      ) : (
                        <div className={about.confirmActions}>
                          <button
                            type="button"
                            className={smallButton}
                            disabled={backup === 'saving'}
                            onClick={() => void onBackup()}
                          >
                            <Download size={13} aria-hidden="true" />
                            {backup === 'saved'
                              ? t('prefs.aboutOlderBackupDone')
                              : t('prefs.aboutOlderBackup')}
                          </button>
                          <button
                            type="button"
                            className={`${controls.btn} ${controls.btnSm} ${controls.btnPrimary}`}
                            onClick={() => void onInstall(release.version)}
                          >
                            {t('prefs.aboutOlderConfirmInstall', { version: release.version })}
                          </button>
                          <button
                            type="button"
                            className={controls.btnLink}
                            onClick={() => setConfirming(null)}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : (
          <button
            type="button"
            className={`${smallButton} ${styles.alignStart}`}
            disabled={list.status === 'loading'}
            onClick={() => void load()}
          >
            <History size={13} aria-hidden="true" />
            {list.status === 'loading' ? t('prefs.aboutOlderLoading') : t('prefs.aboutOlderShow')}
          </button>
        )}
        {list.status === 'error' ? (
          <p className={styles.updateError}>{t('prefs.aboutOlderError', { error: list.error })}</p>
        ) : null}
        {error ? <p className={styles.updateError}>{error}</p> : null}
        <button
          type="button"
          className={`${controls.btnLink} ${styles.alignStart}`}
          onClick={() => void openInBrowser(ALL_RELEASES_URL)}
        >
          {t('prefs.aboutOlderAll')}
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      </div>
    </SettingsSection>
  )
}

function ContributeSection() {
  const t = useT()
  return (
    <SettingsSection
      id="app-contribute"
      title={t('prefs.aboutContributeTitle')}
      description={t('prefs.aboutContributeDesc')}
    >
      <div className={about.linkRow}>
        <LinkButton
          Icon={Bug}
          label={t('prefs.aboutReportBug')}
          url={`${REPO_URL}/issues/new?template=bug_report.yml`}
        />
        <LinkButton
          Icon={Lightbulb}
          label={t('prefs.aboutRequestFeature')}
          url={`${REPO_URL}/issues/new?template=feature_request.yml`}
        />
        <LinkButton
          Icon={GitPullRequest}
          label={t('prefs.aboutOpenPullRequest')}
          url={`${REPO_URL}/compare`}
        />
        <LinkButton
          Icon={BookOpen}
          label={t('prefs.aboutContributingGuide')}
          url={`${REPO_URL}/blob/main/CONTRIBUTING.md`}
        />
      </div>
    </SettingsSection>
  )
}

function InfoSection() {
  const t = useT()
  const rows: { label: string; action: string; Icon: LucideIcon; run: () => Promise<void> }[] = [
    {
      label: t('prefs.aboutLicense'),
      action: 'AGPL-3.0',
      Icon: ExternalLink,
      run: () => openInBrowser(`${REPO_URL}/blob/main/LICENSE`),
    },
    {
      label: t('prefs.aboutPrivacy'),
      action: t('prefs.aboutPrivacyAction'),
      Icon: ExternalLink,
      run: () => openInBrowser(`${REPO_URL}/blob/main/docs/PRIVACY.md`),
    },
    {
      label: t('prefs.aboutSource'),
      action: 'github.com/Kc1t/alethe-agents',
      Icon: ExternalLink,
      run: () => openInBrowser(REPO_URL),
    },
    {
      label: t('prefs.aboutDataFolder'),
      action: t('prefs.aboutOpenFolder'),
      Icon: FolderOpen,
      run: openDataFolder,
    },
    {
      label: t('prefs.aboutLogsFolder'),
      action: t('prefs.aboutOpenFolder'),
      Icon: FolderOpen,
      run: openLogsFolder,
    },
  ]
  return (
    <SettingsSection
      id="app-info"
      title={t('prefs.aboutInfoTitle')}
      description={t('prefs.aboutInfoDesc')}
    >
      <dl className={about.infoList}>
        {rows.map(({ label, action, Icon, run }) => (
          <div key={label} className={about.infoRow}>
            <dt>{label}</dt>
            <dd>
              <button type="button" className={controls.btnLink} onClick={() => void run()}>
                {action}
                <Icon size={12} aria-hidden="true" />
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </SettingsSection>
  )
}

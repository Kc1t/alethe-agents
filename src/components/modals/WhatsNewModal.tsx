import { Newspaper } from 'lucide-react'

import { CHANGELOG_RELEASES, CURRENT_VERSION } from '../../lib/changelogData'
import { intlLocale, useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './WhatsNewModal.module.css'

export function WhatsNewModal() {
  const t = useT()
  const locale = useProjectsStore((s) => s.preferences.language)
  const open = useUiStore((s) => s.openModal === 'whatsNew')
  const closeModal = useUiStore((s) => s.closeModal)
  const openModal = useUiStore((s) => s.openModal_)
  const updateInfo = useUiStore((s) => s.updateInfo)
  if (!open) return null

  const version = updateInfo?.version ?? updateInfo?.currentVersion ?? CURRENT_VERSION
  const hasUpdate = Boolean(updateInfo && updateInfo.version !== updateInfo.currentVersion)

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('whatsNew.title', { version })}
      width={480}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('whatsNew.close')}
          </button>
          {hasUpdate ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={() => openModal('updateAvailable')}
            >
              {t('whatsNew.update')}
            </button>
          ) : null}
        </>
      }
    >
      <div className={styles.hero}>
        <span className={styles.icon}>
          <Newspaper size={18} />
        </span>
        <div>
          <strong>
            {hasUpdate ? t('whatsNew.pendingTitle', { version }) : t('whatsNew.subtitle')}
          </strong>
          <p>
            {hasUpdate
              ? t('whatsNew.pendingBody', { version: updateInfo!.version })
              : t('whatsNew.body')}
          </p>
        </div>
      </div>
      {updateInfo?.notes ? (
        <div className={styles.notes}>{updateInfo.notes}</div>
      ) : (
        <div className={styles.releases}>
          {CHANGELOG_RELEASES.map((release) => (
            <section key={release.version} className={styles.release}>
              <h3 className={styles.releaseHeading}>
                {t('whatsNew.releaseHeading', {
                  version: release.version,
                  date: new Date(release.date).toLocaleDateString(intlLocale(locale)),
                })}
              </h3>
              <ul className={styles.list}>
                {release.noteKeys.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  )
}

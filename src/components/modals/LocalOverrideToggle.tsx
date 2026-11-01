import { Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { adoptSharedVersion, keepOnThisMachine } from '../../lib/sync'
import { onCloudStatusChanged } from '../../lib/sync/events'
import { cloudSyncStatus } from '../../lib/tauri'
import type { Project, ProjectOverrideGroup } from '../../lib/types'
import controls from './controls.module.css'
import styles from './LocalOverrideToggle.module.css'

function useCloudConnected(): boolean {
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    let alive = true
    const check = () =>
      void cloudSyncStatus().then(
        (status) => alive && setConnected(status.connected),
        () => alive && setConnected(false),
      )
    check()
    const unsubscribe = onCloudStatusChanged(check)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  return connected
}

type Props = {
  project: Project
  group: ProjectOverrideGroup
  onAdopted?: () => void
}

export function LocalOverrideToggle({ project, group, onAdopted }: Props) {
  const t = useT()
  const connected = useCloudConnected()
  const [leaving, setLeaving] = useState(false)
  const active = project.localOverrides?.includes(group) ?? false
  const inputId = `local-override-${group}`

  if (!connected && !active) return null

  const adopt = async () => {
    await adoptSharedVersion(project.id, group)
    setLeaving(false)
    onAdopted?.()
  }

  return (
    <div className={styles.box}>
      <div className={controls.checkboxRow}>
        <input
          id={inputId}
          type="checkbox"
          checked={active}
          onChange={() => (active ? setLeaving(true) : keepOnThisMachine(project.id, group, true))}
        />
        <label htmlFor={inputId} className={`${controls.checkboxLabel} ${styles.label}`}>
          <Monitor size={13} />
          {t('projectSync.keepLocal')}
        </label>
      </div>
      <span className={controls.hint}>{t('projectSync.keepLocalHint')}</span>
      {leaving ? (
        <div className={styles.leave}>
          <span className={styles.leaveTitle}>{t('projectSync.leaveLocalTitle')}</span>
          <div className={styles.leaveActions}>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm}`}
              onClick={() => void adopt()}
            >
              {t('projectSync.useShared')}
            </button>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm}`}
              onClick={() => {
                keepOnThisMachine(project.id, group, false)
                setLeaving(false)
              }}
            >
              {t('projectSync.shareThis')}
            </button>
            <button type="button" className={controls.btnLink} onClick={() => setLeaving(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

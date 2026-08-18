import {
  ArrowLeftRight,
  Check,
  Download,
  Loader2,
  PencilLine,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { saveFile } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import {
  DEFAULT_PROFILE_IMAGE_URL,
  getProfileAccountName,
  getProfileImageUrl,
  getProfileInitial,
} from '../../lib/profile'
import {
  createProfile,
  deleteProfile,
  exportProfileBackup,
  listProfileSummaries,
  type ProfileSummary,
  renameProfile,
  setActiveProfile,
  suspendPty,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../ui/Avatar'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './ProfilesModal.module.css'

type BusyAction = null | 'load' | 'create' | 'rename' | 'switch' | 'backup' | 'delete'

function formatDate(ms: number, locale: string): string {
  if (!ms) return '—'
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleDateString()
  }
}

export function ProfilesModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'profiles')
  const closeModal = useUiStore((s) => s.closeModal)
  const profiles = useProjectsStore((s) => s.profiles)
  const hydrate = useProjectsStore((s) => s.hydrate)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const projects = useProjectsStore((s) => s.projects)
  const preferences = useProjectsStore((s) => s.preferences)
  const language = useProjectsStore((s) => s.preferences.language)
  const resetTerminalRuntime = useTerminalsStore((s) => s.reset)

  const [summaries, setSummaries] = useState<ProfileSummary[]>([])
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ProfileSummary | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const [backupReady, setBackupReady] = useState(false)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = async () => {
    setBusy('load')
    setError(null)
    try {
      setSummaries(await listProfileSummaries())
    } catch (err) {
      setError(t('profiles.loadError', { error: String(err) }))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!open) {
      setNewName('')
      setEditingId(null)
      setEditingName('')
      setPendingDelete(null)
      setConfirmName('')
      setBackupReady(false)
      setError(null)
      setNotice(null)
      return
    }
    void load()
  }, [open])

  const fallbackSummaries = useMemo<ProfileSummary[]>(
    () =>
      profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        profile_image_url: profile.id === activeProfileId ? preferences.profileImageUrl : '',
        created_at_ms: profile.created_at_ms,
        last_used_at_ms: profile.last_used_at_ms,
        project_count: profile.id === activeProfileId ? projects.length : 0,
        terminal_count:
          profile.id === activeProfileId
            ? projects.reduce((total, project) => total + project.terminals.length, 0)
            : 0,
        is_active: profile.id === activeProfileId,
      })),
    [activeProfileId, preferences.profileImageUrl, profiles, projects],
  )
  const sourceItems = summaries.length > 0 ? summaries : fallbackSummaries
  const items = sourceItems.map((profile) => ({
    ...profile,
    name: getProfileAccountName({
      profileId: profile.id,
      profileName: profile.name,
      activeProfileId,
      displayName: preferences.displayName,
    }),
  }))
  const activeProfile =
    items.find((profile) => profile.is_active || profile.id === activeProfileId) ?? null
  const currentPtyIds = projects.flatMap((project) =>
    project.terminals.flatMap(
      (terminal) => terminal.tabs.map((tab) => tab.ptyId).filter(Boolean) as string[],
    ),
  )

  const mapError = (err: unknown) => {
    const raw = String(err)
    if (raw.includes('profile_name_exists')) return t('profiles.nameExists')
    if (raw.includes('backup_inside_profile')) return t('profiles.backupInsideProfile')
    return t('profiles.operationError', { error: raw })
  }

  const parkCurrentProfile = async () => {
    const ids = [...new Set(currentPtyIds)]
    await Promise.allSettled(ids.map((id) => suspendPty(id)))
  }

  const reload = () => window.location.reload()

  const applyProfileSwitch = async () => {
    // Clear runtime-only PTY records before replacing the persisted document.
    // Suspended PTYs remain available in the backend and are reattached when
    // the profile is selected again.
    resetTerminalRuntime()
    await hydrate()
    setNotice(null)
    closeModal()
  }

  const create = async () => {
    const trimmed = newName.trim()
    if (!trimmed) {
      setError(t('profiles.nameRequired'))
      return
    }
    setBusy('create')
    setError(null)
    if (items.some((profile) => profile.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      setBusy(null)
      setError(t('profiles.nameExists'))
      return
    }
    let parked = false
    try {
      const created = await createProfile(trimmed)
      const createdProfile = created.profiles.find((profile) => profile.name === trimmed)
      if (!createdProfile) throw new Error('created profile not found')
      await parkCurrentProfile()
      parked = true
      await setActiveProfile(createdProfile.id)
      reload()
    } catch (err) {
      setError(mapError(err))
      setBusy(null)
      if (parked) window.setTimeout(reload, 300)
    }
  }

  const switchProfile = async (profile: ProfileSummary) => {
    if (profile.id === activeProfileId) return
    setBusy('switch')
    setError(null)
    setNotice(t('profiles.switchBusy'))
    try {
      await parkCurrentProfile()
      await setActiveProfile(profile.id)
      await applyProfileSwitch()
    } catch (err) {
      setBusy(null)
      setError(t('profiles.switchError', { error: String(err) }))
    }
  }

  const saveRename = async () => {
    if (!editingId) return
    const trimmed = editingName.trim()
    if (!trimmed) {
      setError(t('profiles.nameRequired'))
      return
    }
    setBusy('rename')
    setError(null)
    try {
      await renameProfile(editingId, trimmed)
      reload()
    } catch (err) {
      setBusy(null)
      setError(mapError(err))
    }
  }

  const exportPendingBackup = async () => {
    if (!pendingDelete) return
    setBusy('backup')
    setError(null)
    try {
      const targetPath = await saveFile({
        title: t('profiles.backupDialogTitle'),
        defaultPath: `alethe-${pendingDelete.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}-backup.zip`,
        filters: [{ name: t('profiles.backupFileType'), extensions: ['zip'] }],
      })
      if (!targetPath) return
      await exportProfileBackup(pendingDelete.id, targetPath)
      setBackupReady(true)
      setNotice(t('profiles.backupReady'))
    } catch (err) {
      setError(mapError(err))
    } finally {
      setBusy(null)
    }
  }

  const removeProfile = async () => {
    if (!pendingDelete || !backupReady || confirmName.trim() !== pendingDelete.name) return
    setBusy('delete')
    setError(null)
    try {
      if (pendingDelete.id === activeProfileId) await parkCurrentProfile()
      await deleteProfile(pendingDelete.id)
      reload()
    } catch (err) {
      setBusy(null)
      setError(mapError(err))
    }
  }

  const startDelete = (profile: ProfileSummary) => {
    setPendingDelete(profile)
    setConfirmName('')
    setBackupReady(false)
    setError(null)
    setNotice(null)
  }

  return (
    <Modal open={open} onClose={closeModal} title={t('profiles.title')} width={760}>
      <div className={styles.root}>
        <div className={styles.intro}>
          <div className={styles.introIcon}>
            <ShieldCheck size={18} />
          </div>
          <div>
            <strong>{t('profiles.localTitle')}</strong>
            <p>{t('profiles.subtitle')}</p>
          </div>
        </div>

        {error ? (
          <div className={styles.feedbackError} role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className={styles.feedbackNotice} role="status">
            {notice}
          </div>
        ) : null}

        <section className={styles.createCard}>
          <div className={styles.createIcon} aria-hidden="true">
            <Plus size={17} />
          </div>
          <div className={styles.createCopy}>
            <h3>{t('profiles.createTitle')}</h3>
            <p>{t('profiles.createDescription')}</p>
          </div>
          <div className={styles.createRow}>
            <input
              className={controls.input}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t('profiles.createPlaceholder')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
              disabled={busy !== null}
            />
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={() => void create()}
              disabled={busy !== null}
            >
              {busy === 'create' ? (
                <Loader2 size={14} className={styles.spin} />
              ) : (
                <Plus size={14} />
              )}
              {t('profiles.createButton')}
            </button>
          </div>
        </section>

        <section className={styles.listSection}>
          <div className={styles.sectionHeader}>
            <div>
              <h3>{t('profiles.listTitle')}</h3>
              <p>{t('profiles.listDescription')}</p>
            </div>
            {busy === 'load' ? <Loader2 size={15} className={styles.spin} /> : null}
          </div>

          {items.length === 0 ? (
            <div className={styles.empty}>{t('profiles.noProfiles')}</div>
          ) : (
            <div className={styles.profileList}>
              {items.map((profile) => {
                const isEditing = editingId === profile.id
                const isBusy = busy !== null
                return (
                  <article
                    key={profile.id}
                    className={`${styles.profileCard} ${profile.is_active ? styles.profileCardActive : ''}`}
                  >
                    <Avatar
                      src={
                        profile.is_active
                          ? getProfileImageUrl(preferences)
                          : profile.profile_image_url || DEFAULT_PROFILE_IMAGE_URL
                      }
                      initial={getProfileInitial(profile.name)}
                      className={styles.profileAvatar}
                      alt={profile.name}
                    />
                    <div className={styles.profileMain}>
                      <div className={styles.profileTitleRow}>
                        <strong>{profile.name}</strong>
                        {profile.is_active ? (
                          <span className={styles.currentBadge}>
                            <Check size={11} />
                            {t('profiles.current')}
                          </span>
                        ) : null}
                      </div>
                      <div className={styles.stats}>
                        <span>{t('profiles.projects', { count: profile.project_count })}</span>
                        <span>{t('profiles.terminals', { count: profile.terminal_count })}</span>
                        <span>
                          {t('profiles.lastUsed', {
                            date: formatDate(
                              profile.last_used_at_ms,
                              language === 'pt-BR' ? 'pt-BR' : 'en-US',
                            ),
                          })}
                        </span>
                      </div>
                    </div>
                    {isEditing ? (
                      <div className={styles.renameRow}>
                        <input
                          className={controls.input}
                          value={editingName}
                          onChange={(event) => setEditingName(event.target.value)}
                          placeholder={t('profiles.renamePlaceholder')}
                          autoFocus
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveRename()
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                        />
                        <button
                          type="button"
                          className={`${controls.btn} ${controls.btnPrimary}`}
                          onClick={() => void saveRename()}
                          disabled={isBusy}
                        >
                          <Check size={14} />
                          {t('common.save')}
                        </button>
                        <button
                          type="button"
                          className={controls.btn}
                          onClick={() => setEditingId(null)}
                          disabled={isBusy}
                        >
                          <X size={14} />
                          {t('common.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className={styles.actions}>
                        {!profile.is_active ? (
                          <button
                            type="button"
                            className={`${controls.btn} ${controls.btnPrimary}`}
                            onClick={() => void switchProfile(profile)}
                            disabled={isBusy}
                          >
                            {busy === 'switch' ? (
                              <Loader2 size={14} className={styles.spin} />
                            ) : (
                              <ArrowLeftRight size={14} />
                            )}
                            {t('profiles.switchButton')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={controls.btn}
                          onClick={() => {
                            setEditingId(profile.id)
                            setEditingName(profile.name)
                            setError(null)
                          }}
                          disabled={isBusy}
                        >
                          <PencilLine size={14} />
                          {t('profiles.renameButton')}
                        </button>
                        <button
                          type="button"
                          className={`${controls.btn} ${controls.btnDanger}`}
                          onClick={() => startDelete(profile)}
                          disabled={isBusy || items.length <= 1}
                        >
                          <Trash2 size={14} />
                          {t('profiles.deleteButton')}
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </section>

        {activeProfile ? (
          <div className={styles.footerHint}>
            {t('profiles.activeHint', { name: activeProfile.name })}
          </div>
        ) : null}

        {pendingDelete ? (
          <section className={styles.deletePanel}>
            <div className={styles.deleteHeader}>
              <div>
                <h3>{t('profiles.deleteTitle', { name: pendingDelete.name })}</h3>
                <p>
                  {t('profiles.deleteDescription', {
                    projects: pendingDelete.project_count,
                    terminals: pendingDelete.terminal_count,
                  })}
                </p>
              </div>
              <button
                type="button"
                className={styles.closeDelete}
                onClick={() => setPendingDelete(null)}
                aria-label={t('common.close')}
              >
                <X size={15} />
              </button>
            </div>
            <button
              type="button"
              className={controls.btn}
              onClick={() => void exportPendingBackup()}
              disabled={busy !== null || backupReady}
            >
              {busy === 'backup' ? (
                <Loader2 size={14} className={styles.spin} />
              ) : (
                <Download size={14} />
              )}
              {backupReady ? t('profiles.backupDone') : t('profiles.exportBackup')}
            </button>
            <label className={controls.field}>
              <span className={controls.label}>{t('profiles.confirmDeleteInput')}</span>
              <input
                className={controls.input}
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                placeholder={pendingDelete.name}
                disabled={!backupReady || busy !== null}
              />
            </label>
            <div className={styles.deleteActions}>
              <button
                type="button"
                className={controls.btn}
                onClick={() => setPendingDelete(null)}
                disabled={busy !== null}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnDanger}`}
                onClick={() => void removeProfile()}
                disabled={
                  !backupReady || confirmName.trim() !== pendingDelete.name || busy !== null
                }
              >
                {busy === 'delete' ? (
                  <Loader2 size={14} className={styles.spin} />
                ) : (
                  <Trash2 size={14} />
                )}
                {t('profiles.confirmDeleteButton')}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}

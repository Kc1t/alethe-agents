import {
  Download,
  FileArchive,
  FileText,
  FolderOpen,
  Globe2,
  Layers,
  Network,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldAlert,
  Sparkles,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react'
import { useRef } from 'react'

import { useOnClickOutside } from '../../hooks/useOnClickOutside'
import { useOnEscape } from '../../hooks/useOnEscape'
import { pickFile, saveFile } from '../../lib/dialog'
import { AGENT_SANDBOX_ENABLED } from '../../lib/featureFlags'
import { useT } from '../../lib/i18n'
import {
  exportBackup,
  exportLogs,
  importBackup,
  killPty,
  openDataFolder,
  openLogsFolder,
  openSpawnLog,
  resetAppData,
  wipeAllAppData,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './MainMenu.module.css'

export function MainMenu() {
  const t = useT()
  const open = useUiStore((s) => s.showMainMenu)
  const closeMainMenu = useUiStore((s) => s.closeMainMenu)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const openModal = useUiStore((s) => s.openModal_)
  const flat = useProjectsStore((s) => s.preferences.workspaceFlat)
  const browserEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.browser)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const projects = useProjectsStore((s) => s.projects)
  const hydrate = useProjectsStore((s) => s.hydrate)
  const setFlat = useProjectsStore((s) => s.setWorkspaceFlat)
  const resetTerminalRuntime = useTerminalsStore((s) => s.reset)

  const ref = useRef<HTMLDivElement>(null)

  useOnClickOutside(ref, () => closeMainMenu(), open)
  useOnEscape(() => closeMainMenu(), open)

  if (!open) return null

  const action = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      console.error(err)
      window.alert(t('common.errorPrefix', { message: String(err) }))
    }
    closeMainMenu()
  }

  const reset = async () => {
    if (!window.confirm(t('menu.confirmReset'))) return
    await resetAppData()
    window.location.reload()
  }

  const factoryReset = async () => {
    if (!window.confirm(t('menu.confirmFactoryReset'))) return
    await wipeAllAppData()
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      // WebView storage may be unavailable; the backend wipe already ran.
    }
    window.location.reload()
  }

  return (
    <div ref={ref} className={styles.menu} role="menu">
      <button
        type="button"
        className={styles.item}
        onClick={() => {
          openModal('preferences')
          closeMainMenu()
        }}
      >
        <Settings size={14} /> <span>{t('menu.preferences')}</span>
      </button>
      {browserEnabled && activeProjectId ? (
        <button
          type="button"
          className={styles.item}
          onClick={() => {
            openModal('addBrowser', { projectId: activeProjectId })
            closeMainMenu()
          }}
        >
          <Globe2 size={14} /> <span>{t('menu.addBrowser')}</span>
        </button>
      ) : null}
      {AGENT_SANDBOX_ENABLED ? (
        <button
          type="button"
          className={styles.item}
          onClick={() => {
            setActiveView('agentSandbox')
            closeMainMenu()
          }}
        >
          <Network size={14} /> <span>{t('menu.agentSandbox')}</span>
        </button>
      ) : null}
      <button
        type="button"
        className={styles.item}
        onClick={() => {
          openModal('remoteControl')
          closeMainMenu()
        }}
      >
        <Network size={14} /> <span>{t('menu.remoteControl')}</span>
      </button>
      <button
        type="button"
        className={styles.item}
        onClick={() => {
          openModal('audit')
          closeMainMenu()
        }}
      >
        <ShieldAlert size={14} /> <span>{t('menu.audit')}</span>
      </button>
      {import.meta.env.DEV ? (
        <>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              openModal('welcome')
              closeMainMenu()
            }}
          >
            <Sparkles size={14} /> <span>{t('menu.welcome')}</span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              openModal('themePicker')
              closeMainMenu()
            }}
          >
            <Sun size={14} />
            <span>{t('menu.pickTheme')}</span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              useProjectsStore.getState().setOnboardingDone(false)
              closeMainMenu()
            }}
          >
            <RefreshCw size={14} /> <span>{t('menu.redoOnboarding')}</span>
          </button>
        </>
      ) : null}
      <button type="button" className={styles.item} onClick={() => setFlat(!flat)}>
        <Layers size={14} />
        <span>{flat ? t('menu.groupByProject') : t('menu.flatMode')}</span>
      </button>
      <div className={styles.separator} />
      <button type="button" className={styles.item} onClick={() => void action(openDataFolder)}>
        <FolderOpen size={14} /> <span>{t('menu.openDataFolder')}</span>
      </button>
      <button type="button" className={styles.item} onClick={() => void action(openSpawnLog)}>
        <FileText size={14} /> <span>{t('menu.openSpawnLog')}</span>
      </button>
      <button type="button" className={styles.item} onClick={() => void action(openLogsFolder)}>
        <ScrollText size={14} /> <span>{t('menu.openLogs')}</span>
      </button>
      <button
        type="button"
        className={styles.item}
        onClick={() =>
          void action(async () => {
            const target = await saveFile({
              title: t('menu.exportLogsTitle'),
              defaultPath: `alethe-logs-${new Date().toISOString().slice(0, 10)}.zip`,
              filters: [{ name: t('menu.logsFilter'), extensions: ['zip'] }],
            })
            if (target) await exportLogs(target)
          })
        }
      >
        <FileArchive size={14} /> <span>{t('menu.exportLogs')}</span>
      </button>
      <div className={styles.separator} />
      <button
        type="button"
        className={styles.item}
        onClick={() =>
          void action(async () => {
            const target = await saveFile({
              title: t('menu.exportBackupTitle'),
              defaultPath: `alethe-backup-${new Date().toISOString().slice(0, 10)}.alethe.zip`,
              filters: [{ name: t('menu.backupFilter'), extensions: ['zip'] }],
            })
            if (target) await exportBackup(target)
          })
        }
      >
        <Download size={14} /> <span>{t('menu.exportBackup')}</span>
      </button>
      <button
        type="button"
        className={styles.item}
        onClick={() =>
          void action(async () => {
            const source = await pickFile({
              title: t('menu.importBackupTitle'),
              filters: [{ name: t('menu.backupFilter'), extensions: ['zip'] }],
            })
            if (!source) return
            if (!window.confirm(t('menu.confirmImport'))) return
            const currentPtyIds = new Set(
              projects.flatMap((project) =>
                project.terminals.flatMap((terminal) =>
                  terminal.tabs.flatMap((tab) => (tab.ptyId ? [tab.ptyId] : [])),
                ),
              ),
            )
            await Promise.allSettled([...currentPtyIds].map((ptyId) => killPty(ptyId)))
            resetTerminalRuntime()
            await importBackup(source)
            await hydrate()
            window.location.reload()
          })
        }
      >
        <Upload size={14} /> <span>{t('menu.importBackup')}</span>
      </button>
      <div className={styles.separator} />
      <button
        type="button"
        className={`${styles.item} ${styles.danger}`}
        onClick={() => void reset()}
      >
        <Trash2 size={14} /> <span>{t('menu.resetAppData')}</span>
      </button>
      <button
        type="button"
        className={`${styles.item} ${styles.danger}`}
        onClick={() => void factoryReset()}
      >
        <Trash2 size={14} /> <span>{t('menu.factoryReset')}</span>
      </button>
    </div>
  )
}

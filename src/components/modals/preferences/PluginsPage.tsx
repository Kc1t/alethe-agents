import {
  ChevronDown,
  CircleAlert,
  FolderInput,
  FolderOpen,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { pickDirectory } from '../../../lib/dialog'
import { type MessageKey, type TFunction, useT } from '../../../lib/i18n'
import type { PluginRuntimeEntry } from '../../../lib/plugins'
import { refreshLocalPlugins, setPluginEnabled, usePlugins } from '../../../lib/plugins'
import type { PluginKind, PluginManifest } from '../../../lib/tauri'
import {
  openInFileExplorer,
  pluginImportDir,
  pluginInstall,
  pluginsDir,
  pluginUninstall,
} from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { Modal } from '../Modal'
import { CapabilityList } from './pluginCapabilities'
import { PluginCatalog } from './PluginCatalog'
import styles from './PluginsPage.module.css'
import { SettingsSection } from './primitives'

const KIND_KEYS: Record<PluginKind, MessageKey> = {
  agentType: 'prefs.pluginsKindAgentType',
  skill: 'prefs.pluginsKindSkill',
  theme: 'prefs.pluginsKindTheme',
  ui: 'prefs.pluginsKindUi',
  validationPipeline: 'prefs.pluginsKindValidationPipeline',
}

function kindLabel(t: TFunction, kind: PluginKind): string {
  const key = KIND_KEYS[kind]
  return key ? t(key) : kind
}

export function PluginsPage() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const plugins = usePlugins()

  const [folder, setFolder] = useState<string | null>(null)
  const [manifestInput, setManifestInput] = useState('')
  const [installing, setInstalling] = useState(false)
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [trustTarget, setTrustTarget] = useState<PluginRuntimeEntry | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<PluginRuntimeEntry | null>(null)

  useEffect(() => {
    void refreshLocalPlugins()
    void pluginsDir()
      .then(setFolder)
      .catch(() => setFolder(null))
  }, [])

  const ordered = useMemo(
    () =>
      [...plugins].sort((a, b) => {
        if (a.source !== b.source) return a.source === 'bundled' ? -1 : 1
        return a.manifest.name.localeCompare(b.manifest.name)
      }),
    [plugins],
  )

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    )
  }, [])

  const handleToggle = (entry: PluginRuntimeEntry, next: boolean) => {
    if (next && entry.source === 'local') {
      setTrustTarget(entry)
      return
    }
    void setPluginEnabled(entry.manifest.id, next)
  }

  const confirmTrust = () => {
    if (!trustTarget) return
    void setPluginEnabled(trustTarget.manifest.id, true)
    setTrustTarget(null)
  }

  const confirmUninstall = async () => {
    if (!uninstallTarget) return
    const { id } = uninstallTarget.manifest
    setUninstallTarget(null)
    try {
      await pluginUninstall(id)
      await refreshLocalPlugins()
      pushToast({ title: t('prefs.pluginsUninstallSuccess'), body: '' })
    } catch (error) {
      pushToast({ title: t('prefs.pluginsUninstallError', { error: String(error) }), body: '' })
    }
  }

  const handleImport = async () => {
    setInstalling(true)
    try {
      const source = await pickDirectory()
      if (!source) return
      const manifest = await pluginImportDir(source)
      await refreshLocalPlugins()
      pushToast({ title: t('prefs.pluginsImportSuccess', { name: manifest.name }), body: '' })
    } catch (error) {
      pushToast({ title: t('prefs.pluginsImportError', { error: String(error) }), body: '' })
    } finally {
      setInstalling(false)
    }
  }

  const handleInstall = async () => {
    const raw = manifestInput.trim()
    if (!raw) return
    setInstalling(true)
    try {
      const manifest = JSON.parse(raw) as PluginManifest
      if (!manifest.id || !manifest.name || !manifest.version || !manifest.kind) {
        pushToast({ title: t('prefs.pluginsInstallInvalid'), body: '' })
        return
      }
      await pluginInstall(manifest)
      await refreshLocalPlugins()
      setManifestInput('')
      pushToast({ title: t('prefs.pluginsInstallSuccess'), body: '' })
    } catch (error) {
      pushToast({ title: t('prefs.pluginsInstallError', { error: String(error) }), body: '' })
    } finally {
      setInstalling(false)
    }
  }

  const handleOpenFolder = async () => {
    if (!folder) return
    try {
      await openInFileExplorer(folder)
    } catch (error) {
      pushToast({ title: t('prefs.pluginsOpenFolderError'), body: String(error) })
    }
  }

  return (
    <>
      <SettingsSection
        id="plugins-installed"
        title={t('prefs.pluginsInstalledTitle')}
        description={t('prefs.pluginsInstalledDesc')}
      >
        {ordered.length === 0 ? (
          <div className={styles.emptyNote}>{t('prefs.pluginsEmpty')}</div>
        ) : (
          <div className={styles.list}>
            {ordered.map((entry) => {
              const { manifest } = entry
              const open = expanded.includes(manifest.id)
              return (
                <div key={manifest.id} className={styles.row}>
                  <div className={styles.rowHead}>
                    <div className={styles.identity}>
                      <div className={styles.titleLine}>
                        <span className={styles.name}>{manifest.name}</span>
                        <span className={styles.version}>
                          {t('prefs.pluginsVersion', { version: manifest.version })}
                        </span>
                        <span
                          className={`${styles.badge} ${
                            entry.source === 'bundled' ? styles.badgeBundled : ''
                          }`}
                        >
                          {entry.source === 'bundled'
                            ? t('prefs.pluginsSourceBundled')
                            : t('prefs.pluginsSourceLocal')}
                        </span>
                      </div>
                      <div className={styles.kind}>{kindLabel(t, manifest.kind)}</div>
                      <p className={styles.description}>{manifest.description}</p>
                      {entry.error ? (
                        <div className={styles.error}>
                          <CircleAlert size={13} />
                          <span>{t('prefs.pluginsActivationError', { error: entry.error })}</span>
                        </div>
                      ) : null}
                    </div>

                    <div className={styles.controls}>
                      <div className={styles.switchRow}>
                        <span
                          className={`${styles.switchLabel} ${
                            entry.enabled ? styles.switchLabelOn : ''
                          }`}
                        >
                          {entry.enabled
                            ? t('prefs.pluginsStatusEnabled')
                            : t('prefs.pluginsStatusDisabled')}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={entry.enabled}
                          aria-label={t('prefs.pluginsToggleLabel', { name: manifest.name })}
                          className={styles.switch}
                          onClick={() => handleToggle(entry, !entry.enabled)}
                        />
                      </div>
                      {entry.source === 'local' ? (
                        <button
                          type="button"
                          className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
                          onClick={() => setUninstallTarget(entry)}
                        >
                          {t('prefs.pluginsUninstall')}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className={styles.capabilities}>
                    <button
                      type="button"
                      className={styles.capabilitiesToggle}
                      aria-expanded={open}
                      onClick={() => toggleExpanded(manifest.id)}
                    >
                      <ChevronDown size={12} />
                      {t('prefs.pluginsCapabilitiesShow', {
                        count: manifest.capabilities.length,
                      })}
                    </button>
                    {open ? <CapabilityList capabilities={manifest.capabilities} /> : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      <PluginCatalog />

      <SettingsSection
        id="plugins-install"
        title={t('prefs.pluginsInstallTitle')}
        description={t('prefs.pluginsInstallDesc')}
      >
        {folder ? (
          <div className={styles.folderRow}>
            <div className={styles.folderCopy}>
              <div className={styles.folderLabel}>{t('prefs.pluginsFolderLabel')}</div>
              <div className={styles.folderPath} title={folder}>
                {folder}
              </div>
            </div>
            <div className={styles.folderActions}>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnSm}`}
                onClick={() => void refreshLocalPlugins()}
              >
                <RefreshCw size={13} />
                {t('prefs.pluginsRescan')}
              </button>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnSm}`}
                onClick={() => void handleOpenFolder()}
              >
                <FolderOpen size={13} />
                {t('prefs.pluginsOpenFolder')}
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.importRow}>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={installing}
            onClick={() => void handleImport()}
          >
            <FolderInput size={14} />
            {t('prefs.pluginsImport')}
          </button>
          <span className={styles.importHint}>{t('prefs.pluginsImportHint')}</span>
        </div>

        <details className={styles.advanced}>
          <summary className={styles.advancedSummary}>{t('prefs.pluginsManifestAdvanced')}</summary>
          <div className={styles.installForm}>
            <label className={controls.label} htmlFor="plugin-manifest">
              {t('prefs.pluginsManifestLabel')}
            </label>
            <textarea
              id="plugin-manifest"
              className={styles.manifestInput}
              value={manifestInput}
              onChange={(event) => setManifestInput(event.target.value)}
              placeholder={t('prefs.pluginsManifestPlaceholder')}
              spellCheck={false}
            />
            <div className={styles.installActions}>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnSm}`}
                disabled={installing || !manifestInput.trim()}
                onClick={() => void handleInstall()}
              >
                {t('prefs.pluginsInstallButton')}
              </button>
            </div>
          </div>
        </details>
      </SettingsSection>

      <Modal
        open={trustTarget !== null}
        onClose={() => setTrustTarget(null)}
        nested
        width={480}
        title={t('prefs.pluginsTrustTitle', { name: trustTarget?.manifest.name ?? '' })}
        footer={
          <>
            <button type="button" className={controls.btn} onClick={() => setTrustTarget(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={confirmTrust}
            >
              {t('prefs.pluginsTrustConfirm')}
            </button>
          </>
        }
      >
        <div className={styles.trustWarning}>
          <ShieldAlert size={15} />
          <span>{t('prefs.pluginsTrustBody')}</span>
        </div>
        <p className={styles.trustCapabilitiesLabel}>{t('prefs.pluginsTrustCapabilities')}</p>
        <CapabilityList capabilities={trustTarget?.manifest.capabilities ?? []} />
      </Modal>

      <Modal
        open={uninstallTarget !== null}
        onClose={() => setUninstallTarget(null)}
        nested
        width={440}
        title={t('prefs.pluginsUninstallTitle', { name: uninstallTarget?.manifest.name ?? '' })}
        footer={
          <>
            <button type="button" className={controls.btn} onClick={() => setUninstallTarget(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnDanger}`}
              onClick={() => void confirmUninstall()}
            >
              {t('prefs.pluginsUninstallConfirm')}
            </button>
          </>
        }
      >
        <p className={styles.trustBody}>{t('prefs.pluginsUninstallBody')}</p>
      </Modal>
    </>
  )
}

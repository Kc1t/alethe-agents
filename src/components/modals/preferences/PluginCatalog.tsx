import { CloudOff, Download, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { PLUGIN_API_VERSION, refreshLocalPlugins, usePlugins } from '../../../lib/plugins'
import {
  type CatalogPlugin,
  pluginCatalog,
  pluginCatalogOpen,
  pluginInstallFromCatalog,
} from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { CapabilityList } from './pluginCapabilities'
import styles from './PluginsPage.module.css'
import { SettingsSection } from './primitives'

export function PluginCatalog() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const installed = usePlugins()
  const [entries, setEntries] = useState<CatalogPlugin[] | null>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true)
    try {
      const snapshot = await pluginCatalog(PLUGIN_API_VERSION, refresh)
      setEntries(snapshot.plugins)
      setStale(snapshot.stale)
      setError(null)
    } catch (cause) {
      setEntries([])
      setError(String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const open = async (plugin: CatalogPlugin) => {
    try {
      await pluginCatalogOpen(PLUGIN_API_VERSION, plugin.downloadUrl)
    } catch (cause) {
      pushToast({ title: t('prefs.pluginsCatalogOpenError'), body: String(cause) })
    }
  }

  const install = async (plugin: CatalogPlugin) => {
    setInstalling(plugin.id)
    try {
      await pluginInstallFromCatalog(PLUGIN_API_VERSION, plugin.id)
      await refreshLocalPlugins()
      pushToast({
        title: t('prefs.pluginsCatalogInstallDone', { name: plugin.name }),
        body: t('prefs.pluginsCatalogInstallDoneBody'),
      })
    } catch (cause) {
      pushToast({ title: t('prefs.pluginsCatalogInstallError'), body: String(cause) })
    } finally {
      setInstalling(null)
    }
  }

  return (
    <SettingsSection
      id="plugins-catalog"
      title={t('prefs.pluginsCatalogTitle')}
      description={t('prefs.pluginsCatalogDesc')}
    >
      <div className={styles.catalogHead}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          disabled={loading}
          onClick={() => void load(true)}
        >
          <RefreshCw size={13} />
          {t('prefs.pluginsCatalogRefresh')}
        </button>
        {stale ? (
          <span className={styles.catalogStale}>
            <CloudOff size={13} />
            {t('prefs.pluginsCatalogStale')}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className={styles.emptyNote}>{t('prefs.pluginsCatalogError')}</div>
      ) : entries === null ? (
        <div className={styles.emptyNote}>{t('prefs.pluginsCatalogLoading')}</div>
      ) : entries.length === 0 ? (
        <div className={styles.emptyNote}>{t('prefs.pluginsCatalogEmpty')}</div>
      ) : (
        <div className={styles.list}>
          {entries.map((plugin) => {
            const local = installed.find((entry) => entry.manifest.id === plugin.id)
            const alreadyInstalled = local !== undefined
            const outdated =
              local !== undefined &&
              plugin.version !== '' &&
              local.manifest.version !== plugin.version
            const busy = installing === plugin.id
            return (
              <div key={plugin.id} className={styles.row}>
                <div className={styles.rowHead}>
                  <div className={styles.identity}>
                    <div className={styles.titleLine}>
                      <span className={styles.name}>{plugin.name}</span>
                      {plugin.version ? (
                        <span className={styles.version}>
                          {t('prefs.pluginsVersion', { version: plugin.version })}
                        </span>
                      ) : null}
                      {outdated ? (
                        <span className={styles.badge}>
                          {t('prefs.pluginsCatalogUpdateAvailable', {
                            version: local.manifest.version,
                          })}
                        </span>
                      ) : alreadyInstalled ? (
                        <span className={styles.badge}>{t('prefs.pluginsCatalogInstalled')}</span>
                      ) : null}
                    </div>
                    {plugin.description ? (
                      <p className={styles.description}>{plugin.description}</p>
                    ) : null}
                    {plugin.author ? (
                      <p className={styles.description}>
                        {t('prefs.pluginsCatalogBy', { author: plugin.author })}
                      </p>
                    ) : null}
                    {plugin.package ? (
                      <p className={styles.catalogPinned}>
                        <ShieldCheck size={13} />
                        {t('prefs.pluginsCatalogPinned')}
                      </p>
                    ) : null}
                  </div>
                  <div className={styles.catalogActions}>
                    {plugin.package ? (
                      <button
                        type="button"
                        className={`${controls.btn} ${controls.btnSm}`}
                        disabled={busy || installing !== null}
                        onClick={() => void install(plugin)}
                      >
                        <Download size={13} />
                        {busy
                          ? t('prefs.pluginsCatalogInstalling')
                          : outdated
                            ? t('prefs.pluginsCatalogUpdate')
                            : alreadyInstalled
                              ? t('prefs.pluginsCatalogReinstall')
                              : t('prefs.pluginsCatalogInstall')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={`${controls.btn} ${controls.btnSm}`}
                        onClick={() => void open(plugin)}
                      >
                        <Download size={13} />
                        {t('prefs.pluginsCatalogGet')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.catalogSource}
                      onClick={() => void open(plugin)}
                    >
                      <ExternalLink size={12} />
                      {t('prefs.pluginsCatalogSource')}
                    </button>
                  </div>
                </div>
                <CapabilityList capabilities={plugin.capabilities} />
              </div>
            )
          })}
        </div>
      )}

      <p className={styles.importHint}>{t('prefs.pluginsCatalogHint')}</p>
    </SettingsSection>
  )
}

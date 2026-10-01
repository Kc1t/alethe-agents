import { Blocks, Download, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../lib/i18n'
import type { PaneProps } from '../../lib/plugins'
import {
  PLUGIN_API_VERSION,
  refreshLocalPlugins,
  setPluginEnabled,
  usePlugins,
} from '../../lib/plugins'
import { pluginCatalogOpen, pluginInstallFromCatalog, pluginUninstall } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { CapabilityList } from '../modals/preferences/pluginCapabilities'
import { useCatalog } from '../PluginsSidebar/useCatalog'
import styles from './PluginDetailPane.module.css'

export function PluginDetailPane({ terminal }: PaneProps) {
  const t = useT()
  const pluginId = terminal.pluginId ?? ''
  const installed = usePlugins().find((entry) => entry.manifest.id === pluginId)
  const { entries } = useCatalog()
  const listing = entries.find((entry) => entry.id === pluginId)
  const pushToast = useUiStore((state) => state.pushToast)
  const [busy, setBusy] = useState(false)
  const [trustOpen, setTrustOpen] = useState(false)

  if (!installed && !listing) {
    return <div className={styles.missing}>{t('pluginPane.missing')}</div>
  }

  const name = installed?.manifest.name ?? listing?.name ?? pluginId
  const version = installed?.manifest.version ?? listing?.version ?? ''
  const description = installed?.manifest.description || listing?.description || ''
  const capabilities = installed?.manifest.capabilities ?? listing?.capabilities ?? []
  const outdated =
    installed !== undefined &&
    listing !== undefined &&
    listing.version !== '' &&
    installed.manifest.version !== listing.version

  const install = async () => {
    setBusy(true)
    try {
      await pluginInstallFromCatalog(PLUGIN_API_VERSION, pluginId)
      await refreshLocalPlugins()
      pushToast({
        title: t('prefs.pluginsCatalogInstallDone', { name }),
        body: t('prefs.pluginsCatalogInstallDoneBody'),
      })
    } catch (error) {
      pushToast({ title: t('prefs.pluginsCatalogInstallError'), body: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const uninstall = async () => {
    setBusy(true)
    try {
      await pluginUninstall(pluginId)
      await refreshLocalPlugins()
      pushToast({ title: t('prefs.pluginsUninstallSuccess'), body: '' })
    } catch (error) {
      pushToast({ title: t('prefs.pluginsUninstallError', { error: String(error) }), body: '' })
    } finally {
      setBusy(false)
    }
  }

  const toggle = () => {
    if (!installed) return
    if (!installed.enabled && installed.source === 'local') {
      setTrustOpen(true)
      return
    }
    void setPluginEnabled(pluginId, !installed.enabled)
  }

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <div className={styles.icon}>
          <Blocks size={22} />
        </div>
        <div className={styles.identity}>
          <div className={styles.titleLine}>
            <h2 className={styles.name}>{name}</h2>
            {version ? (
              <span className={styles.version}>{t('prefs.pluginsVersion', { version })}</span>
            ) : null}
            <span className={styles.badge}>
              {installed
                ? installed.source === 'bundled'
                  ? t('prefs.pluginsSourceBundled')
                  : t('prefs.pluginsSourceLocal')
                : t('pluginPane.notInstalled')}
            </span>
          </div>
          <p className={styles.meta}>
            {listing?.author ? t('prefs.pluginsCatalogBy', { author: listing.author }) : pluginId}
            {installed
              ? ` · ${
                  installed.enabled
                    ? t('prefs.pluginsStatusEnabled')
                    : t('prefs.pluginsStatusDisabled')
                }`
              : ''}
          </p>
        </div>
      </header>

      <div className={styles.actions}>
        {installed ? (
          <button type="button" className={styles.button} onClick={toggle}>
            {installed.enabled ? t('pluginPane.disable') : t('pluginPane.enable')}
          </button>
        ) : null}
        {listing?.package ? (
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={busy}
            onClick={() => void install()}
          >
            <Download size={13} />
            {busy
              ? t('prefs.pluginsCatalogInstalling')
              : outdated
                ? t('prefs.pluginsCatalogUpdate')
                : installed
                  ? t('prefs.pluginsCatalogReinstall')
                  : t('prefs.pluginsCatalogInstall')}
          </button>
        ) : null}
        {listing ? (
          <button
            type="button"
            className={styles.button}
            onClick={() =>
              void pluginCatalogOpen(PLUGIN_API_VERSION, listing.downloadUrl).catch((error) =>
                pushToast({ title: t('prefs.pluginsCatalogOpenError'), body: String(error) }),
              )
            }
          >
            <ExternalLink size={13} />
            {t('prefs.pluginsCatalogSource')}
          </button>
        ) : null}
        {installed?.source === 'local' ? (
          <button
            type="button"
            className={styles.buttonDanger}
            disabled={busy}
            onClick={() => void uninstall()}
          >
            {t('prefs.pluginsUninstall')}
          </button>
        ) : null}
      </div>

      {listing?.package ? (
        <p className={styles.pinned}>
          <ShieldCheck size={13} />
          {t('prefs.pluginsCatalogPinned')}
        </p>
      ) : null}

      {installed?.error ? (
        <p className={styles.error}>
          {t('prefs.pluginsActivationError', { error: installed.error })}
        </p>
      ) : null}

      {description ? <p className={styles.description}>{description}</p> : null}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{t('pluginPane.permissions')}</h3>
        <CapabilityList capabilities={capabilities} />
      </section>

      {listing?.repo ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('pluginPane.repository')}</h3>
          <p className={styles.mono}>{listing.repo}</p>
        </section>
      ) : null}

      {trustOpen ? (
        <div className={styles.trust}>
          <div className={styles.trustHead}>
            <ShieldAlert size={15} />
            <strong>{t('prefs.pluginsTrustTitle', { name })}</strong>
          </div>
          <p className={styles.trustBody}>{t('prefs.pluginsTrustBody')}</p>
          <p className={styles.trustBody}>{t('prefs.pluginsTrustCapabilities')}</p>
          <CapabilityList capabilities={capabilities} />
          <div className={styles.trustActions}>
            <button type="button" className={styles.button} onClick={() => setTrustOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={() => {
                setTrustOpen(false)
                void setPluginEnabled(pluginId, true)
              }}
            >
              {t('prefs.pluginsTrustConfirm')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

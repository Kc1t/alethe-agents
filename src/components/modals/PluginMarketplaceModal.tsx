import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, Download, RefreshCw, Search, ShieldAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type MessageKey, useT } from '../../lib/i18n'
import {
  PLUGIN_API_VERSION,
  refreshLocalPlugins,
  requiresTrustConfirmation,
  setPluginEnabled,
  usePlugins,
} from '../../lib/plugins'
import {
  type BrowseFilter,
  type BrowseRow,
  type BrowseSort,
  browseRows,
  capabilityFacets,
  EMPTY_FILTER,
  listWindow,
  mergeRows,
  type PluginOrigin,
} from '../../lib/pluginBrowse'
import {
  type CatalogSnapshot,
  pluginCatalog,
  pluginCatalogOpen,
  pluginInstallFromCatalog,
  pluginUninstall,
} from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import { CapabilityList, CAPABILITY_KEYS } from './preferences/pluginCapabilities'
import styles from './PluginMarketplaceModal.module.css'

const ROW_HEIGHT = 68
const SORTS: BrowseSort[] = ['updated', 'name']
const SORT_KEYS: Record<BrowseSort, MessageKey> = {
  name: 'market.sortName',
  updated: 'market.sortUpdated',
}
const ORIGIN_KEYS: Record<PluginOrigin, MessageKey> = {
  bundled: 'market.sourceBundled',
  local: 'market.sourceLocal',
}

type Tab = 'browse' | 'installed'

export function PluginMarketplaceModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'pluginMarketplace')
  const closeModal = useUiStore((state) => state.closeModal)
  const pushToast = useUiStore((state) => state.pushToast)
  const installedPlugins = usePlugins()

  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('browse')
  const [filter, setFilter] = useState<BrowseFilter>(EMPTY_FILTER)
  const [sort, setSort] = useState<BrowseSort>('updated')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [trustTarget, setTrustTarget] = useState<BrowseRow | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(560)
  const listRef = useRef<HTMLDivElement>(null)
  const attemptRef = useRef(0)

  const load = useCallback(async (refresh = false) => {
    const attempt = ++attemptRef.current
    setLoading(true)
    try {
      const next = await pluginCatalog(PLUGIN_API_VERSION, refresh)
      if (attemptRef.current !== attempt) return
      setSnapshot(next)
      setCatalogFailed(false)
    } catch {
      if (attemptRef.current !== attempt) return
      // The catalogue failing says nothing about what is installed, so the Installed tab stays
      // fully usable: only the marketplace side reports the outage.
      setCatalogFailed(true)
    } finally {
      if (attemptRef.current === attempt) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
    return () => {
      // Reopening should not resume someone else's search from last week.
      setFilter(EMPTY_FILTER)
      setSelected(null)
      setScrollTop(0)
    }
  }, [open, load])

  const rows = useMemo(
    () =>
      mergeRows(
        snapshot?.plugins ?? [],
        installedPlugins.map((entry) => ({
          id: entry.manifest.id,
          name: entry.manifest.name,
          description: entry.manifest.description ?? '',
          version: entry.manifest.version,
          capabilities: entry.manifest.capabilities ?? [],
          enabled: entry.enabled,
          origin: (entry.source === 'bundled' ? 'bundled' : 'local') as PluginOrigin,
        })),
      ),
    [snapshot, installedPlugins],
  )

  const scoped = useMemo(
    () => rows.filter((row) => (tab === 'installed' ? row.installed : true)),
    [rows, tab],
  )
  const visible = useMemo(() => browseRows(scoped, filter, sort), [scoped, filter, sort])
  const facets = useMemo(() => capabilityFacets(scoped), [scoped])
  const installedCount = useMemo(() => rows.filter((row) => row.installed).length, [rows])
  const detail = useMemo(
    () => (selected ? (rows.find((row) => row.id === selected) ?? null) : null),
    [rows, selected],
  )

  useEffect(() => {
    const element = listRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    setViewport(element.clientHeight)
    return () => observer.disconnect()
  }, [detail])

  const window = listWindow(visible.length, scrollTop, viewport, ROW_HEIGHT)
  const mounted = visible.slice(window.start, window.end)

  const install = async (row: BrowseRow) => {
    setBusy(row.id)
    try {
      await pluginInstallFromCatalog(PLUGIN_API_VERSION, row.id)
      await refreshLocalPlugins()
      pushToast({
        title: t('market.installDone', { name: row.name }),
        body: t('market.installDoneBody'),
      })
    } catch (cause) {
      pushToast({ title: t('market.installFailed'), body: String(cause) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (row: BrowseRow) => {
    setBusy(row.id)
    try {
      await pluginUninstall(row.id)
      await refreshLocalPlugins()
      setSelected(null)
    } catch (cause) {
      pushToast({ title: t('market.installFailed'), body: String(cause) })
    } finally {
      setBusy(null)
    }
  }

  const applyEnabled = async (row: BrowseRow, next: boolean) => {
    setBusy(row.id)
    try {
      await setPluginEnabled(row.id, next)
    } catch (cause) {
      pushToast({ title: t('market.installFailed'), body: String(cause) })
    } finally {
      setBusy(null)
    }
  }

  const toggle = (row: BrowseRow) => {
    const next = !row.enabled
    // Enabling is where consent is given, and the marketplace must not be the cheap way around the
    // question Preferences asks. Same rule, one implementation.
    if (row.origin && requiresTrustConfirmation(row.origin, next)) {
      setTrustTarget(row)
      return
    }
    void applyEnabled(row, next)
  }

  const toggleCapability = (capability: string) =>
    setFilter((current) => ({
      ...current,
      capabilities: current.capabilities.includes(capability)
        ? current.capabilities.filter((entry) => entry !== capability)
        : [...current.capabilities, capability],
    }))

  const toggleOrigin = (origin: PluginOrigin) =>
    setFilter((current) => ({
      ...current,
      origins: current.origins.includes(origin)
        ? current.origins.filter((entry) => entry !== origin)
        : [...current.origins, origin],
    }))

  const filtering =
    filter.query.trim().length > 0 ||
    filter.capabilities.length > 0 ||
    filter.origins.length > 0 ||
    filter.enabled !== null

  const rowAction = (row: BrowseRow) => {
    if (row.updateTo) {
      return (
        <button
          type="button"
          className={styles.primary}
          disabled={busy === row.id}
          onClick={(event) => {
            event.stopPropagation()
            void install(row)
          }}
        >
          {busy === row.id ? t('market.installing') : t('market.update', { version: row.updateTo })}
        </button>
      )
    }
    if (row.installed)
      return <span className={styles.installedMark}>{t('market.installedMark')}</span>
    if (!row.installable) return null
    return (
      <button
        type="button"
        className={styles.primary}
        disabled={busy === row.id}
        onClick={(event) => {
          event.stopPropagation()
          void install(row)
        }}
      >
        <Download size={12} />
        {busy === row.id ? t('market.installing') : t('market.install')}
      </button>
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && closeModal()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={undefined}>
          <header className={styles.header}>
            <Dialog.Title className={styles.title}>{t('market.title')}</Dialog.Title>
            <div className={styles.searchWrap}>
              <Search size={13} />
              <input
                autoFocus
                value={filter.query}
                placeholder={t('market.search')}
                aria-label={t('market.search')}
                onChange={(event) =>
                  setFilter((current) => ({ ...current, query: event.target.value }))
                }
              />
            </div>
            <label className={styles.sort}>
              <span>{t('market.sort')}</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as BrowseSort)}>
                {SORTS.map((option) => (
                  <option key={option} value={option}>
                    {t(SORT_KEYS[option])}
                  </option>
                ))}
              </select>
            </label>
            <Dialog.Close className={styles.close} aria-label={t('common.close')}>
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className={styles.body}>
            <nav className={styles.rail}>
              <button
                type="button"
                className={tab === 'browse' ? styles.tabActive : styles.tab}
                onClick={() => {
                  setTab('browse')
                  setSelected(null)
                }}
              >
                {t('market.browse')}
              </button>
              <button
                type="button"
                className={tab === 'installed' ? styles.tabActive : styles.tab}
                onClick={() => {
                  setTab('installed')
                  setSelected(null)
                }}
              >
                {t('market.installed')}
                <span className={styles.count}>{installedCount}</span>
              </button>

              {facets.length > 0 ? (
                <>
                  <p className={styles.railLabel}>{t('market.filterCapabilities')}</p>
                  {facets.map((capability) => {
                    const key = CAPABILITY_KEYS[capability]
                    const on = filter.capabilities.includes(capability)
                    return (
                      <button
                        key={capability}
                        type="button"
                        className={on ? styles.facetOn : styles.facet}
                        aria-pressed={on}
                        onClick={() => toggleCapability(capability)}
                      >
                        {key ? t(key) : capability}
                      </button>
                    )
                  })}
                </>
              ) : null}

              {tab === 'installed' ? (
                <>
                  <p className={styles.railLabel}>{t('market.filterSource')}</p>
                  {(['bundled', 'local'] as PluginOrigin[]).map((origin) => {
                    const on = filter.origins.includes(origin)
                    return (
                      <button
                        key={origin}
                        type="button"
                        className={on ? styles.facetOn : styles.facet}
                        aria-pressed={on}
                        onClick={() => toggleOrigin(origin)}
                      >
                        {t(ORIGIN_KEYS[origin])}
                      </button>
                    )
                  })}
                  <p className={styles.railLabel}>{t('market.filterState')}</p>
                  {[true, false].map((state) => {
                    const on = filter.enabled === state
                    return (
                      <button
                        key={String(state)}
                        type="button"
                        className={on ? styles.facetOn : styles.facet}
                        aria-pressed={on}
                        onClick={() =>
                          setFilter((current) => ({
                            ...current,
                            enabled: current.enabled === state ? null : state,
                          }))
                        }
                      >
                        {t(state ? 'market.stateEnabled' : 'market.stateDisabled')}
                      </button>
                    )
                  })}
                </>
              ) : null}

              {filtering ? (
                <button
                  type="button"
                  className={styles.clear}
                  onClick={() => setFilter(EMPTY_FILTER)}
                >
                  {t('market.clear')}
                </button>
              ) : null}
            </nav>

            {detail ? (
              <section className={styles.detail}>
                <button type="button" className={styles.back} onClick={() => setSelected(null)}>
                  <ArrowLeft size={13} />
                  {t('market.back')}
                </button>
                <h2 className={styles.detailName}>{detail.name}</h2>
                <p className={styles.detailMeta}>
                  <span>{detail.version}</span>
                  {detail.author ? <span>{t('market.by', { author: detail.author })}</span> : null}
                  {detail.origin ? <span>{t(ORIGIN_KEYS[detail.origin])}</span> : null}
                </p>
                {detail.description ? (
                  <p className={styles.detailBody}>{detail.description}</p>
                ) : null}

                <p className={styles.railLabel}>{t('market.detailCapabilities')}</p>
                <ul className={styles.capabilities}>
                  {detail.capabilities.map((capability) => {
                    const key = CAPABILITY_KEYS[capability]
                    return (
                      <li key={capability}>
                        {key ? t(key) : <code className={styles.raw}>{capability}</code>}
                      </li>
                    )
                  })}
                </ul>
                <p className={styles.caution}>{t('market.fullPower')}</p>

                {!detail.installable && !detail.installed ? (
                  <>
                    <p className={styles.note}>{t('market.notInstallable')}</p>
                    {detail.pageUrl ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => {
                          void pluginCatalogOpen(PLUGIN_API_VERSION, detail.pageUrl ?? '').catch(
                            (cause) =>
                              pushToast({
                                title: t('prefs.pluginsCatalogOpenError'),
                                body: String(cause),
                              }),
                          )
                        }}
                      >
                        {t('market.openPage')}
                      </button>
                    ) : null}
                  </>
                ) : null}

                <div className={styles.detailActions}>
                  {rowAction(detail)}
                  {detail.installed ? (
                    <>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy === detail.id}
                        onClick={() => toggle(detail)}
                      >
                        {t(detail.enabled ? 'market.disable' : 'market.enable')}
                      </button>
                      {detail.origin === 'local' ? (
                        <button
                          type="button"
                          className={styles.danger}
                          disabled={busy === detail.id}
                          onClick={() => void remove(detail)}
                          title={t('market.uninstallWarning')}
                        >
                          {t('market.uninstall')}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
                {detail.installed && detail.origin === 'local' ? (
                  <p className={styles.note}>{t('market.uninstallWarning')}</p>
                ) : null}
              </section>
            ) : (
              <section className={styles.main}>
                <div className={styles.status}>
                  <span>{t('market.results', { count: visible.length })}</span>
                  {snapshot?.stale ? (
                    <span className={styles.stale}>{t('market.stale')}</span>
                  ) : null}
                  <button
                    type="button"
                    className={styles.refresh}
                    disabled={loading}
                    onClick={() => void load(true)}
                  >
                    <RefreshCw size={12} />
                    {t('market.retry')}
                  </button>
                </div>

                <div
                  ref={listRef}
                  className={styles.list}
                  onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                >
                  {loading && visible.length === 0 ? (
                    <p className={styles.empty}>{t('market.loading')}</p>
                  ) : catalogFailed && tab === 'browse' ? (
                    <p className={styles.empty}>{t('market.error')}</p>
                  ) : visible.length === 0 ? (
                    <p className={styles.empty}>
                      {filtering
                        ? t('market.emptySearch')
                        : t(tab === 'installed' ? 'market.emptyInstalled' : 'market.emptyCatalog')}
                    </p>
                  ) : (
                    <>
                      <div style={{ height: window.padTop }} />
                      {mounted.map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          className={styles.row}
                          style={{ height: ROW_HEIGHT }}
                          onClick={() => setSelected(row.id)}
                        >
                          <span className={styles.rowMain}>
                            <span className={styles.rowHead}>
                              <b>{row.name}</b>
                              <span className={styles.version}>{row.version}</span>
                              {row.author ? (
                                <span className={styles.author}>
                                  {t('market.by', { author: row.author })}
                                </span>
                              ) : null}
                            </span>
                            <span className={styles.rowDesc}>{row.description}</span>
                          </span>
                          {rowAction(row)}
                        </button>
                      ))}
                      <div style={{ height: window.padBottom }} />
                    </>
                  )}
                </div>
              </section>
            )}
          </div>
          <Modal
            open={trustTarget !== null}
            onClose={() => setTrustTarget(null)}
            nested
            width={480}
            title={t('prefs.pluginsTrustTitle', { name: trustTarget?.name ?? '' })}
            footer={
              <>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setTrustTarget(null)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => {
                    if (trustTarget) void applyEnabled(trustTarget, true)
                    setTrustTarget(null)
                  }}
                >
                  {t('prefs.pluginsTrustConfirm')}
                </button>
              </>
            }
          >
            <p className={styles.caution}>
              <ShieldAlert size={14} /> {t('prefs.pluginsTrustBody')}
            </p>
            <p className={styles.railLabel}>{t('prefs.pluginsTrustCapabilities')}</p>
            <CapabilityList capabilities={trustTarget?.capabilities ?? []} />
          </Modal>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

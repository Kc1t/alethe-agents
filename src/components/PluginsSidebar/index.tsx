import { Blocks, CloudOff, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { usePlugins } from '../../lib/plugins'
import {
  mergePluginMarket,
  searchPluginMarket,
  type PluginMarketStatus,
  type PluginMarketSource,
  type PluginMarketSort,
} from '../../lib/pluginMarket'
import { PluginDetailsModal } from './PluginDetailsModal'
import { PluginMarketFilters } from './PluginMarketFilters'
import styles from './PluginsSidebar.module.css'
import { useCatalog } from './useCatalog'

export function PluginsSidebar() {
  const t = useT()
  const installed = usePlugins()
  const { entries, loading, stale, reload } = useCatalog()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<PluginMarketStatus>('all')
  const [source, setSource] = useState<PluginMarketSource>('all')
  const [sort, setSort] = useState<PluginMarketSort>('relevance')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const allRows = useMemo(() => mergePluginMarket(installed, entries), [installed, entries])
  const rows = useMemo(
    () => searchPluginMarket(allRows, query, status, source, sort),
    [allRows, query, status, source, sort],
  )
  const selected = allRows.find((row) => row.id === selectedId)

  return (
    <aside className={styles.sidebar} aria-label={t('pluginsTab.title')}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <Blocks size={16} />
          <span>{t('pluginsTab.title')}</span>
          {stale ? (
            <span className={styles.stale} title={t('prefs.pluginsCatalogStale')}>
              <CloudOff size={12} />
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void reload(true)}
          disabled={loading}
          title={t('pluginsTab.refresh')}
          aria-label={t('pluginsTab.refresh')}
        >
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        </button>
      </header>

      <PluginMarketFilters
        query={query}
        setQuery={setQuery}
        status={status}
        setStatus={setStatus}
        source={source}
        setSource={setSource}
        sort={sort}
        setSort={setSort}
        count={rows.length}
        total={allRows.length}
      />

      <div className={styles.content}>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            {loading ? t('pluginsTab.loading') : t('pluginsTab.empty')}
          </div>
        ) : (
          <div className={styles.list}>
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={styles.card}
                onClick={() => setSelectedId(row.id)}
              >
                <div className={styles.cardTop}>
                  <span className={styles.name}>{row.name}</span>
                  {row.version ? <span className={styles.version}>{row.version}</span> : null}
                  {row.outdated ? (
                    <span className={styles.updateBadge}>{t('pluginsTab.updateBadge')}</span>
                  ) : row.installed && !row.enabled ? (
                    <span className={styles.offBadge}>{t('pluginsTab.offBadge')}</span>
                  ) : null}
                </div>
                {row.description ? <p className={styles.description}>{row.description}</p> : null}
                <p className={styles.meta}>
                  {row.installed ? t('pluginsTab.installed') : t('pluginsTab.available')}
                  {row.author ? ` · ${t('prefs.pluginsCatalogBy', { author: row.author })}` : ''}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
      {selectedId ? (
        <PluginDetailsModal
          pluginId={selectedId}
          name={selected?.name ?? selectedId}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </aside>
  )
}

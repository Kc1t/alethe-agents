import { Search } from 'lucide-react'
import { useT } from '../../lib/i18n'
import type {
  PluginMarketStatus,
  PluginMarketSource,
  PluginMarketSort,
} from '../../lib/pluginMarket'
import styles from './PluginsSidebar.module.css'

export function PluginMarketFilters({
  query,
  setQuery,
  status,
  setStatus,
  source,
  setSource,
  sort,
  setSort,
  count,
  total,
}: {
  query: string
  setQuery: (value: string) => void
  status: PluginMarketStatus
  setStatus: (value: PluginMarketStatus) => void
  source: PluginMarketSource
  setSource: (value: PluginMarketSource) => void
  sort: PluginMarketSort
  setSort: (value: PluginMarketSort) => void
  count: number
  total: number
}) {
  const t = useT()
  const filtered = query !== '' || status !== 'all' || source !== 'all' || sort !== 'relevance'
  return (
    <>
      <div className={styles.searchRow}>
        <Search size={13} />
        <input
          type="search"
          className={styles.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('pluginsTab.searchPlaceholder')}
          spellCheck={false}
          aria-label={t('pluginsTab.searchPlaceholder')}
        />
      </div>

      <div className={styles.filters}>
        <label className={styles.filterLabel}>
          {t('pluginsTab.filterStatus')}
          <select
            className={styles.filterSelect}
            value={status}
            onChange={(event) => setStatus(event.target.value as PluginMarketStatus)}
          >
            {(['all', 'installed', 'available', 'enabled', 'disabled', 'updates'] as const).map(
              (value) => (
                <option key={value} value={value}>
                  {t(`pluginsTab.status.${value}`)}
                </option>
              ),
            )}
          </select>
        </label>
        <label className={styles.filterLabel}>
          {t('pluginsTab.filterSource')}
          <select
            className={styles.filterSelect}
            value={source}
            onChange={(event) => setSource(event.target.value as PluginMarketSource)}
          >
            {(['all', 'bundled', 'local', 'catalog'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`pluginsTab.source.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filterLabel}>
          {t('pluginsTab.sort')}
          <select
            className={styles.filterSelect}
            value={sort}
            onChange={(event) => setSort(event.target.value as PluginMarketSort)}
          >
            {(['relevance', 'name', 'installed', 'updates'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`pluginsTab.sort.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.results}>
        <span aria-live="polite">{t('pluginsTab.results', { count: count, total: total })}</span>
        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setStatus('all')
              setSource('all')
              setSort('relevance')
            }}
          >
            {t('pluginsTab.clearFilters')}
          </button>
        ) : null}
      </div>
    </>
  )
}

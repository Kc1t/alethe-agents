import { Blocks, CloudOff, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { usePlugins } from '../../lib/plugins'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './PluginsSidebar.module.css'
import { useCatalog } from './useCatalog'

type Row = {
  id: string
  name: string
  description: string
  author: string
  version: string
  installed: boolean
  enabled: boolean
  outdated: boolean
}

export function PluginsSidebar() {
  const t = useT()
  const installed = usePlugins()
  const { entries, loading, stale, reload } = useCatalog()
  const [query, setQuery] = useState('')
  const createPluginPane = useProjectsStore((state) => state.createPluginPane)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const pushToast = useUiStore((state) => state.pushToast)

  const rows = useMemo(() => {
    const byId = new Map<string, Row>()
    for (const entry of installed) {
      byId.set(entry.manifest.id, {
        id: entry.manifest.id,
        name: entry.manifest.name,
        description: entry.manifest.description,
        author: '',
        version: entry.manifest.version,
        installed: true,
        enabled: entry.enabled,
        outdated: false,
      })
    }
    for (const plugin of entries) {
      const local = byId.get(plugin.id)
      byId.set(plugin.id, {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description || local?.description || '',
        author: plugin.author,
        version: local?.version ?? plugin.version,
        installed: local?.installed ?? false,
        enabled: local?.enabled ?? false,
        outdated: local !== undefined && plugin.version !== '' && local.version !== plugin.version,
      })
    }
    const needle = query.trim().toLowerCase()
    return [...byId.values()]
      .filter((row) =>
        needle === ''
          ? true
          : `${row.name} ${row.id} ${row.author} ${row.description}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [entries, installed, query])

  const openProfile = (row: Row) => {
    const { projects, activeProjectId } = useProjectsStore.getState()
    const project = projects.find((entry) => entry.id === activeProjectId) ?? projects[0]
    if (!project) {
      pushToast({ title: t('pluginsTab.noProject'), body: '' })
      return
    }
    const existing = project.terminals.find(
      (terminal) => terminal.kind === 'plugin' && terminal.pluginId === row.id,
    )
    const pane = existing ?? createPluginPane(project.id, row.id, row.name)
    setActiveTerminal(project.id, pane.id)
  }

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

      <div className={styles.searchRow}>
        <Search size={13} />
        <input
          type="search"
          className={styles.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('pluginsTab.searchPlaceholder')}
          spellCheck={false}
        />
      </div>

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
                onClick={() => openProfile(row)}
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
    </aside>
  )
}

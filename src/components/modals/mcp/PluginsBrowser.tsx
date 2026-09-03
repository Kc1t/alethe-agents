import { AlertTriangle, Copy, FileCode, Lock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import {
  type PluginDetail,
  type PluginScopeSnapshot,
  pluginsDetail,
  pluginsImport,
  pluginsScan,
  type PluginSummary,
} from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import { EmptyState } from '../../EmptyState'
import controls from '../controls.module.css'
import styles from './PluginsBrowser.module.css'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Plugins the agent loads, split by which configuration they live in.
 *
 * Unlike MCP servers and skills, plugins are not copied between agents — OpenCode is the only agent
 * with this concept today, so a four-agent matrix would be three permanently empty columns. The
 * axis that matters here is scope: a plugin in the machine's own OpenCode configuration is not
 * loaded by agents started from Alethe, and importing it is what changes that.
 */
export function PluginsBrowser() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)

  const [snapshots, setSnapshots] = useState<PluginScopeSnapshot[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      setSnapshots(await pluginsScan())
    } catch (error) {
      console.error('[plugins] scan failed:', error)
      setSnapshots([])
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const alethe = snapshots?.find((snapshot) => snapshot.scope === 'alethe') ?? null
  const user = snapshots?.find((snapshot) => snapshot.scope === 'user') ?? null

  /** Plugins in the machine's configuration that Alethe does not have. These are the only ones an
   *  import can do anything about; the rest are already loaded here. */
  const importable = useMemo(() => {
    const present = new Set((alethe?.plugins ?? []).map((plugin) => plugin.name))
    return (user?.plugins ?? []).filter(
      (plugin) => plugin.origin === 'directory' && plugin.exists && !present.has(plugin.name),
    )
  }, [alethe, user])

  const active =
    [...(alethe?.plugins ?? []), ...(user?.plugins ?? [])].find(
      (plugin) => plugin.path === selected,
    ) ?? null

  useEffect(() => {
    if (!active || !active.exists) {
      setDetail(null)
      return
    }
    let cancelled = false
    void pluginsDetail(active.path)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch((error) => {
        console.error(`[plugins] detail failed for ${active.path}:`, error)
        if (!cancelled) setDetail(null)
      })
    return () => {
      cancelled = true
    }
  }, [active?.path, active?.exists])

  const runImport = async (names: string[]) => {
    if (names.length === 0) return
    setBusy(true)
    try {
      const outcomes = await pluginsImport(names)
      const copied = outcomes.filter((outcome) => outcome.status === 'ok')
      if (copied.length > 0) {
        pushToast({
          title: t('plugins.importDoneTitle'),
          body: t('plugins.importDoneBody', { count: copied.length }),
        })
      }
      // Refusals are never folded into the success message: a plugin that was skipped or failed did
      // NOT arrive, and calling it imported would surface only as a plugin that never runs.
      for (const outcome of outcomes.filter((item) => item.status !== 'ok')) {
        pushToast({
          title: t('plugins.importRefusedTitle', { name: outcome.name }),
          body: outcome.reason ?? t(`plugins.importStatus.${outcome.status}` as MessageKey),
        })
      }
      await load()
    } catch (error) {
      pushToast({ title: t('plugins.importFailedTitle'), body: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const total = (alethe?.plugins.length ?? 0) + (user?.plugins.length ?? 0)

  return (
    <div className={styles.wrap}>
      <div className={styles.list}>
        <ScopeSection
          snapshot={alethe}
          titleKey="plugins.scopeAlethe"
          hintKey="plugins.scopeAletheHint"
          selected={selected}
          onSelect={setSelected}
        />
        <ScopeSection
          snapshot={user}
          titleKey="plugins.scopeUser"
          hintKey="plugins.scopeUserHint"
          selected={selected}
          onSelect={setSelected}
          action={
            importable.length > 0 ? (
              <button
                type="button"
                className={controls.btnLink}
                disabled={busy}
                onClick={() => void runImport(importable.map((plugin) => plugin.name))}
              >
                <Copy size={11} />
                {t('plugins.importAll', { count: importable.length })}
              </button>
            ) : null
          }
          importableNames={new Set(importable.map((plugin) => plugin.name))}
          onImport={(name) => void runImport([name])}
          busy={busy}
        />
      </div>

      <div className={styles.detail}>
        {total === 0 ? (
          <EmptyState compact icon={<FileCode size={20} />} title={t('plugins.emptyTitle')} />
        ) : active ? (
          <PluginDetailView detail={detail} summary={active} />
        ) : (
          <div className={styles.placeholder}>
            <EmptyState compact icon={<FileCode size={20} />} title={t('plugins.selectOne')} />
          </div>
        )}
      </div>
    </div>
  )
}

function ScopeSection({
  snapshot,
  titleKey,
  hintKey,
  selected,
  onSelect,
  action,
  importableNames,
  onImport,
  busy,
}: {
  snapshot: PluginScopeSnapshot | null
  titleKey: MessageKey
  hintKey: MessageKey
  selected: string | null
  onSelect: (path: string) => void
  action?: React.ReactNode
  importableNames?: Set<string>
  onImport?: (name: string) => void
  busy?: boolean
}) {
  const t = useT()
  return (
    <section className={styles.scope}>
      <div className={styles.scopeHead}>
        <span className={styles.scopeTitle}>{t(titleKey)}</span>
        {action}
      </div>
      <p className={styles.scopeHint}>{t(hintKey)}</p>
      {snapshot?.root ? (
        <p className={styles.scopeRoot} title={snapshot.root}>
          {snapshot.root}
        </p>
      ) : null}
      {(snapshot?.plugins.length ?? 0) === 0 ? (
        <p className={styles.scopeEmpty}>{t('plugins.scopeEmpty')}</p>
      ) : (
        snapshot?.plugins.map((plugin) => (
          <div key={plugin.path} className={styles.row}>
            <button
              type="button"
              className={`${styles.rowMain} ${selected === plugin.path ? styles.rowActive : ''}`}
              onClick={() => onSelect(plugin.path)}
            >
              <span className={styles.rowName}>{plugin.name}</span>
              <span className={styles.rowMeta}>
                {plugin.managed ? (
                  <span className={styles.badge} title={t('plugins.badgeManagedHint')}>
                    <Lock size={9} /> {t('plugins.badgeManaged')}
                  </span>
                ) : null}
                {plugin.origin === 'declared' ? (
                  <span className={styles.badge}>{t('plugins.badgeDeclared')}</span>
                ) : null}
                {plugin.exists ? (
                  <span className={styles.size}>{formatSize(plugin.size)}</span>
                ) : (
                  <span className={styles.missing}>
                    <AlertTriangle size={9} /> {t('plugins.badgeMissing')}
                  </span>
                )}
              </span>
            </button>
            {importableNames?.has(plugin.name) && onImport ? (
              <button
                type="button"
                className={`${controls.btn} ${controls.btnSm}`}
                disabled={busy}
                onClick={() => onImport(plugin.name)}
              >
                <Copy size={11} />
                {t('plugins.importHere')}
              </button>
            ) : null}
          </div>
        ))
      )}
    </section>
  )
}

function PluginDetailView({
  detail,
  summary,
}: {
  detail: PluginDetail | null
  summary: PluginSummary
}) {
  const t = useT()
  return (
    <>
      <header className={styles.detailHead}>
        <span className={styles.detailName}>{summary.name}</span>
        <span className={styles.detailPath} title={summary.path}>
          {summary.path}
        </span>
      </header>

      {summary.managed ? (
        <div className={styles.warning}>
          <AlertTriangle size={14} />
          <span>{t('plugins.managedWarning')}</span>
        </div>
      ) : null}

      {!summary.exists ? (
        <div className={styles.warning}>
          <AlertTriangle size={14} />
          <span>{t('plugins.missingWarning')}</span>
        </div>
      ) : null}

      <div className={styles.sectionTitle}>
        {summary.origin === 'directory'
          ? t('plugins.originDirectory')
          : t('plugins.originDeclared')}
      </div>

      {detail ? (
        <>
          <pre className={styles.source}>{detail.source}</pre>
          {detail.truncated ? <p className={styles.truncated}>{t('plugins.truncated')}</p> : null}
        </>
      ) : summary.exists ? (
        <p className={styles.scopeEmpty}>{t('plugins.loadingSource')}</p>
      ) : null}
    </>
  )
}

import { AlertTriangle, Eye, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  groupServersByName,
  matchesQuery,
  mcpErrorKey,
  transportSummary,
  type McpServerGroup,
} from '../../lib/mcp'
import { mcpRemove, mcpRevealEnv, mcpSetEnabled } from '../../lib/tauri'
import type { McpAgent, McpEnvEntry, McpServerRecord } from '../../lib/types'
import { AGENT_TYPE_LABELS, MCP_AGENTS } from '../../lib/types'
import { useMcpStore } from '../../stores/mcpStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './McpManagerModal.module.css'

export function McpManagerModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'mcpManager')
  const requestedServer = useUiStore((state) => state.modalContext?.server)
  const closeModal = useUiStore((state) => state.closeModal)
  const pushToast = useUiStore((state) => state.pushToast)

  const scope = useMcpStore((state) => state.scope)
  const repo = useMcpStore((state) => state.repo)
  const snapshots = useMcpStore((state) => state.snapshots)
  const capabilities = useMcpStore((state) => state.capabilities)
  const refresh = useMcpStore((state) => state.refresh)

  const [term, setTerm] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [confirmTarget, setConfirmTarget] = useState<McpServerRecord | null>(null)

  const groups = useMemo(() => groupServersByName(snapshots), [snapshots])
  const visible = useMemo(
    () => groups.filter((group) => matchesQuery(group, term)),
    [groups, term],
  )
  const active = groups.find((group) => group.name === selected) ?? visible[0] ?? null

  useEffect(() => {
    if (!open) return
    setRevealed({})
    if (typeof requestedServer === 'string') setSelected(requestedServer)
  }, [open, scope, requestedServer])

  if (!open) return null

  const reportError = (error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error)
    pushToast({ title: t('mcp.writeFailed'), body: t(mcpErrorKey(raw)) })
  }

  const runMutation = async (key: string, action: () => Promise<unknown>) => {
    setPending(key)
    try {
      await action()
      await refresh()
    } catch (error) {
      reportError(error)
    } finally {
      setPending(null)
    }
  }

  const toggle = (record: McpServerRecord) =>
    runMutation(`${record.agent}:enabled`, () =>
      mcpSetEnabled(record.agent, scope, repo, record.server.name, !record.server.enabled),
    )

  const confirmRemove = async () => {
    const record = confirmTarget
    if (!record) return
    setConfirmTarget(null)
    await runMutation(`${record.agent}:remove`, () =>
      mcpRemove(record.agent, scope, repo, record.server.name),
    )
  }

  const reveal = async (record: McpServerRecord, key: string, header: boolean) => {
    const cacheKey = `${record.agent}:${header ? 'h' : 'e'}:${key}`
    try {
      const value = await mcpRevealEnv(
        record.agent,
        scope,
        repo,
        record.server.name,
        key,
        header,
      )
      setRevealed((current) => ({ ...current, [cacheKey]: value }))
    } catch (error) {
      reportError(error)
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('mcp.managerTitle')}
      width={880}
      footer={
        <>
          <span className={styles.footerNote}>
            {scope === 'project' ? repo ?? '' : t('mcp.scopeGlobalHint')}
          </span>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.search}>
            <Search size={13} />
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder={t('mcp.search')}
              aria-label={t('mcp.search')}
            />
          </div>
          <div className={styles.serverList}>
            {visible.map((group) => (
              <button
                key={group.name}
                type="button"
                className={`${styles.serverButton} ${
                  active?.name === group.name ? styles.serverButtonActive : ''
                }`}
                onClick={() => setSelected(group.name)}
              >
                <span>{group.name}</span>
                <span className={styles.count}>{group.agents.length}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className={styles.detail}>
          {active ? (
            <ServerDetail
              group={active}
              pending={pending}
              revealed={revealed}
              enabledFlagFor={(agent) => capabilities[agent]?.enabledFlag ?? false}
              onToggle={toggle}
              onRemove={setConfirmTarget}
              onReveal={reveal}
            />
          ) : (
            <div className={styles.placeholder}>
              <EmptyState
                compact
                icon={<Search size={20} />}
                title={groups.length === 0 ? t('mcp.emptyTitle') : t('mcp.noMatch')}
              />
            </div>
          )}
        </section>
      </div>

      {confirmTarget ? (
        <Modal
          nested
          open
          onClose={() => setConfirmTarget(null)}
          title={t('mcp.removeTitle')}
          width={420}
          footer={
            <>
              <button
                type="button"
                className={controls.btn}
                onClick={() => setConfirmTarget(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={controls.btnDanger}
                onClick={() => void confirmRemove()}
              >
                {t('mcp.removeAction')}
              </button>
            </>
          }
        >
          <p className={styles.muted}>
            {t('mcp.removeBody', {
              name: confirmTarget.server.name,
              agent: AGENT_TYPE_LABELS[confirmTarget.agent],
            })}
          </p>
          <p className={styles.detailSummary}>{confirmTarget.sourcePath}</p>
          {confirmTarget.managedByImport ? (
            <p className={styles.warning}>
              <AlertTriangle size={14} />
              {t('mcp.managedByImportHint', { plugin: confirmTarget.managedByImport })}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </Modal>
  )
}

type DetailProps = {
  group: McpServerGroup
  pending: string | null
  revealed: Record<string, string>
  enabledFlagFor: (agent: McpAgent) => boolean
  onToggle: (record: McpServerRecord) => void
  onRemove: (record: McpServerRecord) => void
  onReveal: (record: McpServerRecord, key: string, header: boolean) => void
}

function ServerDetail({
  group,
  pending,
  revealed,
  enabledFlagFor,
  onToggle,
  onRemove,
  onReveal,
}: DetailProps) {
  const t = useT()
  const primary = group.records[0]
  const importedFrom = group.records.find((record) => record.managedByImport)?.managedByImport
  const headers =
    primary.server.transport.kind === 'stdio' ? {} : primary.server.transport.headers

  return (
    <>
      <div className={styles.detailHead}>
        <span className={styles.detailName}>{group.name}</span>
        <span className={styles.detailSummary}>
          {transportSummary(primary.server.transport)}
        </span>
      </div>

      {importedFrom ? (
        <div className={styles.warning}>
          <AlertTriangle size={14} />
          <span>{t('mcp.managedByImportHint', { plugin: importedFrom })}</span>
        </div>
      ) : null}

      <div>
        <div className={styles.sectionTitle}>{t('mcp.detailAgents')}</div>
        <div className={styles.agentCards}>
          {MCP_AGENTS.map((agent) => {
            const record = group.records.find((item) => item.agent === agent)
            if (!record) {
              return (
                <div
                  key={agent}
                  className={`${styles.agentCard} ${styles.agentCardAbsent}`}
                >
                  <span className={styles.agentName}>{AGENT_TYPE_LABELS[agent]}</span>
                  <span className={styles.agentPath}>{t('mcp.notConfigured')}</span>
                </div>
              )
            }
            return (
              <div key={agent} className={styles.agentCard}>
                <span className={styles.agentName}>{AGENT_TYPE_LABELS[agent]}</span>
                <span className={styles.agentPath} title={record.sourcePath}>
                  {record.sourcePath}
                </span>
                <span className={styles.agentActions}>
                  {enabledFlagFor(agent) ? (
                    <button
                      type="button"
                      className={styles.miniBtn}
                      disabled={pending !== null}
                      onClick={() => onToggle(record)}
                    >
                      {record.server.enabled ? t('mcp.disable') : t('mcp.enable')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.miniBtn} ${styles.miniBtnDanger}`}
                    disabled={pending !== null}
                    onClick={() => onRemove(record)}
                    title={t('mcp.removeAction')}
                    aria-label={t('mcp.removeAction')}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <div className={styles.sectionTitle}>{t('mcp.detailEnv')}</div>
        <EnvTable
          record={primary}
          entries={primary.server.env}
          header={false}
          revealed={revealed}
          onReveal={onReveal}
        />
      </div>

      {Object.keys(headers).length > 0 ? (
        <div>
          <div className={styles.sectionTitle}>{t('mcp.detailHeaders')}</div>
          <EnvTable
            record={primary}
            entries={headers}
            header
            revealed={revealed}
            onReveal={onReveal}
          />
        </div>
      ) : null}
    </>
  )
}

type EnvTableProps = {
  record: McpServerRecord
  entries: Record<string, McpEnvEntry>
  header: boolean
  revealed: Record<string, string>
  onReveal: (record: McpServerRecord, key: string, header: boolean) => void
}

function EnvTable({ record, entries, header, revealed, onReveal }: EnvTableProps) {
  const t = useT()
  const keys = Object.keys(entries)
  if (keys.length === 0) return <p className={styles.muted}>{t('mcp.detailNoEnv')}</p>

  return (
    <div className={styles.envTable}>
      {keys.map((key) => {
        const entry = entries[key]
        const cacheKey = `${record.agent}:${header ? 'h' : 'e'}:${key}`
        const shown = revealed[cacheKey]
        return (
          <div key={key} className={styles.envRow}>
            <span className={styles.envKey}>{key}</span>
            <span className={styles.envValue}>
              {shown ?? entry.literal?.preview ?? ''}
              {entry.passthroughFrom ? (
                <span className={styles.envPassthrough}>
                  {' '}
                  {t('mcp.passthroughFrom', { name: entry.passthroughFrom })}
                </span>
              ) : null}
            </span>
            {entry.literal && !entry.literal.empty && shown === undefined ? (
              <button
                type="button"
                className={styles.miniBtn}
                onClick={() => onReveal(record, key, header)}
              >
                <Eye size={11} />
                {t('mcp.reveal')}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

import { AlertTriangle, Copy, Eye, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  groupServersByName,
  matchesQuery,
  mcpErrorKey,
  type McpServerGroup,
  transportSummary,
} from '../../lib/mcp'
import {
  type McpHealth,
  mcpHealthCheck,
  mcpRemove,
  mcpRevealEnv,
  mcpSetEnabled,
  mcpSync,
} from '../../lib/tauri'
import type { McpAgent, McpEnvEntry, McpServerRecord } from '../../lib/types'
import { AGENT_TYPE_LABELS, MCP_AGENTS } from '../../lib/types'
import { useMcpStore } from '../../stores/mcpStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import controls from './controls.module.css'
import { AddServerFlow } from './mcp/AddServerFlow'
import { SkillsBrowser } from './mcp/SkillsBrowser'
import styles from './McpManagerModal.module.css'
import { Modal } from './Modal'

type ManagerTab = 'servers' | 'skills'

/** Must identify the exact value: two servers of one agent can share an env key name. */
function revealKey(record: McpServerRecord, key: string, header: boolean): string {
  return `${record.agent}:${record.sourceKind}:${record.server.name}:${header ? 'h' : 'e'}:${key}`
}

export function McpManagerModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'mcpManager')
  const requestedServer = useUiStore((state) => state.modalContext?.server)
  const requestedTab = useUiStore((state) => state.modalContext?.tab)
  const requestedAdd = useUiStore((state) => state.modalContext?.add)
  const closeModal = useUiStore((state) => state.closeModal)
  const pushToast = useUiStore((state) => state.pushToast)

  const scope = useMcpStore((state) => state.scope)
  const repo = useMcpStore((state) => state.repo)
  const snapshots = useMcpStore((state) => state.snapshots)
  const capabilities = useMcpStore((state) => state.capabilities)
  const refresh = useMcpStore((state) => state.refresh)

  const dark = useProjectsStore(
    (state) => state.preferences.uiTheme !== 'light' && state.preferences.uiTheme !== 'min-light',
  )

  const [tab, setTab] = useState<ManagerTab>('servers')
  const [term, setTerm] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [confirmTarget, setConfirmTarget] = useState<McpServerRecord[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [health, setHealth] = useState<Partial<Record<McpAgent, McpHealth[]>>>({})
  const [checking, setChecking] = useState<McpAgent | null>(null)

  const writableAgents = useMemo(
    () =>
      snapshots
        .filter((snapshot) =>
          snapshot.sources.some((item) => item.parseError === null && item.writable),
        )
        .map((snapshot) => snapshot.agent),
    [snapshots],
  )

  const groups = useMemo(() => groupServersByName(snapshots), [snapshots])
  const visible = useMemo(() => groups.filter((group) => matchesQuery(group, term)), [groups, term])
  const active = groups.find((group) => group.name === selected) ?? visible[0] ?? null

  // Runs without an open guard so a revealed plaintext value does not sit in component
  // state after the modal is closed.
  useEffect(() => {
    setRevealed({})
  }, [open, scope])

  // Deps must not include the state this writes, or picking a server in the list would
  // re-run it and snap the selection back to whatever opened the modal.
  useEffect(() => {
    if (!open) return
    if (typeof requestedServer === 'string') setSelected(requestedServer)
    if (requestedTab === 'servers' || requestedTab === 'skills') setTab(requestedTab)
    if (requestedAdd === true) setAdding(true)
  }, [open, requestedServer, requestedTab, requestedAdd])

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
      mcpSetEnabled(
        record.agent,
        scope,
        repo,
        record.server.name,
        !record.server.enabled,
        record.sourceKind,
      ),
    )

  const confirmRemove = async () => {
    const records = confirmTarget
    if (!records || records.length === 0) return
    setConfirmTarget(null)
    await runMutation('remove', async () => {
      for (const record of records) {
        await mcpRemove(record.agent, scope, repo, record.server.name, record.sourceKind)
      }
    })
  }

  const sync = async (from: McpAgent, targets: McpAgent[], name: string) => {
    setPending(`sync:${targets.join(',')}`)
    try {
      const outcomes = await mcpSync(from, targets, scope, repo, name)
      const names = (status: string) =>
        outcomes
          .filter((outcome) => outcome.status === status)
          .map((outcome) => AGENT_TYPE_LABELS[outcome.agent])
          .join(', ')

      const written = names('written')
      const blocked = outcomes.filter((outcome) => outcome.status === 'blocked')
      const failedOutcomes = outcomes.filter((outcome) => outcome.status === 'failed')
      const failed = names('failed')

      if (written) {
        pushToast({
          title: t('mcp.syncWritten', { name, agents: written }),
          body: outcomes
            .filter((outcome) => outcome.status === 'written')
            .map((outcome) => outcome.path ?? '')
            .join('\n'),
        })
      }
      if (blocked.length > 0) {
        pushToast({
          title: t('mcp.syncBlocked', {
            agents: blocked.map((outcome) => AGENT_TYPE_LABELS[outcome.agent]).join(', '),
          }),
          body: blocked
            .flatMap((outcome) => outcome.unsupported.map((item) => item.field))
            .join(', '),
        })
      }
      if (failed) {
        pushToast({
          title: t('mcp.syncFailed', { agents: failed }),
          body: [
            ...new Set(failedOutcomes.map((outcome) => t(mcpErrorKey(outcome.error ?? '')))),
          ].join(' '),
        })
      }
      await refresh()
    } catch (error) {
      reportError(error)
    } finally {
      setPending(null)
    }
  }

  const runHealthCheck = async (agent: McpAgent) => {
    setChecking(agent)
    try {
      const probed = await mcpHealthCheck(agent)
      setHealth((current) => ({ ...current, [agent]: probed }))
    } catch (error) {
      reportError(error)
    } finally {
      setChecking(null)
    }
  }

  const reveal = async (record: McpServerRecord, key: string, header: boolean) => {
    const cacheKey = revealKey(record, key, header)
    try {
      const value = await mcpRevealEnv(record.agent, scope, repo, record.server.name, key, header)
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
            {scope === 'project' ? (repo ?? '') : t('mcp.scopeGlobalHint')}
          </span>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <div className={controls.tabRow} role="tablist">
        {(['servers', 'skills'] as ManagerTab[]).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={tab === option}
            className={`${controls.tabBtn} ${tab === option ? controls.tabBtnActive : ''}`}
            onClick={() => setTab(option)}
          >
            {t(option === 'servers' ? 'mcp.tabServers' : 'mcp.tabSkills')}
          </button>
        ))}
      </div>

      {tab === 'skills' ? <SkillsBrowser dark={dark} /> : null}

      <div className={styles.layout} hidden={tab !== 'servers'}>
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
          <button
            type="button"
            className={styles.addButton}
            onClick={() => setAdding(true)}
            disabled={writableAgents.length === 0}
          >
            <Plus size={13} />
            {t('mcp.addServer')}
          </button>
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
              onSync={sync}
              health={health}
              checking={checking}
              onCheck={runHealthCheck}
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

      {adding ? (
        <AddServerFlow
          scope={scope}
          repo={repo}
          capabilities={capabilities}
          availableAgents={writableAgents}
          onClose={() => setAdding(false)}
          onDone={() => void refresh()}
        />
      ) : null}

      {confirmTarget ? (
        <Modal
          nested
          open
          onClose={() => setConfirmTarget(null)}
          title={t('mcp.removeTitle')}
          width={420}
          footer={
            <>
              <button type="button" className={controls.btn} onClick={() => setConfirmTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnDanger}`}
                onClick={() => void confirmRemove()}
              >
                {t('mcp.removeAction')}
              </button>
            </>
          }
        >
          <p className={styles.muted}>
            {t('mcp.removeBody', {
              name: confirmTarget[0].server.name,
              agent: [
                ...new Set(confirmTarget.map((record) => AGENT_TYPE_LABELS[record.agent])),
              ].join(', '),
            })}
          </p>
          {confirmTarget.map((record) => (
            <p key={record.sourcePath} className={styles.detailSummary}>
              {record.sourcePath}
            </p>
          ))}
          {confirmTarget.some((record) => record.managedByImport) ? (
            <p className={styles.warning}>
              <AlertTriangle size={14} />
              {t('mcp.managedByImportHint', {
                plugin:
                  confirmTarget.find((record) => record.managedByImport)?.managedByImport ?? '',
              })}
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
  onRemove: (records: McpServerRecord[]) => void
  onReveal: (record: McpServerRecord, key: string, header: boolean) => void
  onSync: (from: McpAgent, targets: McpAgent[], name: string) => void
  health: Partial<Record<McpAgent, McpHealth[]>>
  checking: McpAgent | null
  onCheck: (agent: McpAgent) => void
}

function ServerDetail({
  group,
  pending,
  revealed,
  enabledFlagFor,
  onToggle,
  onRemove,
  onReveal,
  onSync,
  health,
  checking,
  onCheck,
}: DetailProps) {
  const t = useT()
  const primary = group.records[0]
  const importedFrom = group.records.find((record) => record.managedByImport)?.managedByImport
  const headers = primary.server.transport.kind === 'stdio' ? {} : primary.server.transport.headers

  return (
    <>
      <div className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          <span className={styles.detailName}>{group.name}</span>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
            disabled={pending !== null}
            onClick={() => onRemove(group.records)}
          >
            <Trash2 size={11} />
            {group.records.length > 1
              ? t('mcp.removeAllAction', { count: group.records.length })
              : t('mcp.removeAction')}
          </button>
        </div>
        <span className={styles.detailSummary}>{transportSummary(primary.server.transport)}</span>
      </div>

      {importedFrom ? (
        <div className={styles.warning}>
          <AlertTriangle size={14} />
          <span>{t('mcp.managedByImportHint', { plugin: importedFrom })}</span>
        </div>
      ) : null}

      <div>
        <div className={styles.sectionTitle}>
          {t('mcp.detailAgents')}
          {group.missingAgents.length > 0 ? (
            <button
              type="button"
              className={controls.btnLink}
              disabled={pending !== null}
              onClick={() => onSync(primary.agent, group.missingAgents, group.name)}
            >
              <Copy size={11} />
              {t('mcp.copyToAll', { count: group.missingAgents.length })}
            </button>
          ) : null}
        </div>
        <div className={styles.agentCards}>
          {MCP_AGENTS.flatMap((agent) => {
            const records = group.records.filter((item) => item.agent === agent)
            if (records.length === 0) {
              return [
                <div key={agent} className={`${styles.agentCard} ${styles.agentCardAbsent}`}>
                  <span className={styles.agentName}>{AGENT_TYPE_LABELS[agent]}</span>
                  <span className={styles.agentPath}>{t('mcp.notConfigured')}</span>
                  {group.missingAgents.includes(agent) ? (
                    <span className={styles.agentActions}>
                      <button
                        type="button"
                        className={`${controls.btn} ${controls.btnSm}`}
                        disabled={pending !== null}
                        onClick={() => onSync(primary.agent, [agent], group.name)}
                      >
                        <Copy size={11} />
                        {t('mcp.copyHere')}
                      </button>
                    </span>
                  ) : null}
                </div>,
              ]
            }
            const probed = health[agent]
            const reported = probed?.find((item) => item.name === group.name)
            return records.map((record) => (
              <div key={`${agent}:${record.sourceKind}`} className={styles.agentCard}>
                <span className={styles.agentName}>{AGENT_TYPE_LABELS[agent]}</span>
                {record.sourceKind !== 'user' ? (
                  <span className={styles.badge}>{t(`mcp.source.${record.sourceKind}`)}</span>
                ) : null}
                {probed ? (
                  <span
                    className={`${styles.badge} ${
                      reported?.status === 'connected'
                        ? styles.badgeOk
                        : reported && reported.status !== 'unknown'
                          ? styles.badgeWarn
                          : ''
                    }`}
                  >
                    {t(`mcp.health.${reported?.status ?? 'absent'}`)}
                  </span>
                ) : null}
                <span className={styles.agentPath} title={record.sourcePath}>
                  {record.sourcePath}
                </span>
                <span className={styles.agentActions}>
                  {agent !== 'antigravity' ? (
                    <button
                      type="button"
                      className={`${controls.btn} ${controls.btnSm}`}
                      disabled={checking !== null}
                      onClick={() => onCheck(agent)}
                      title={t('mcp.healthCheckHint')}
                    >
                      {checking === agent ? t('mcp.healthChecking') : t('mcp.healthCheck')}
                    </button>
                  ) : null}
                  {enabledFlagFor(agent) ? (
                    <button
                      type="button"
                      className={`${controls.btn} ${controls.btnSm}`}
                      disabled={pending !== null}
                      onClick={() => onToggle(record)}
                    >
                      {record.server.enabled ? t('mcp.disable') : t('mcp.enable')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
                    disabled={pending !== null}
                    onClick={() => onRemove([record])}
                    title={t('mcp.removeAction')}
                    aria-label={t('mcp.removeAction')}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            ))
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
        const shown = revealed[revealKey(record, key, header)]
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
                className={`${controls.btn} ${controls.btnSm}`}
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

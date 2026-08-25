import { Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { mcpErrorKey, parsePastedServer, unsupportedFor } from '../../../lib/mcp'
import {
  mcpRegistrySearch,
  mcpUpsert,
  type McpCatalogEntry,
  type McpEnvInput,
  type McpInstallOption,
  type McpRegistryPage,
  type McpServerInput,
} from '../../../lib/tauri'
import type { McpAgent, McpCapability, McpScope } from '../../../lib/types'
import { AGENT_TYPE_LABELS, MCP_AGENTS } from '../../../lib/types'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { Modal } from '../Modal'
import styles from './AddServerFlow.module.css'

type Source = 'manual' | 'paste' | 'registry'
type TransportKind = 'stdio' | 'http' | 'sse'
type RegistryFilter = 'all' | 'local' | 'remote'

type EnvRow = { key: string; value: string; passthrough: boolean }

type Props = {
  scope: McpScope
  repo: string | null
  capabilities: Partial<Record<McpAgent, McpCapability>>
  availableAgents: McpAgent[]
  initialSource?: Source
  onClose: () => void
  onDone: () => void
}

const EMPTY_ROW: EnvRow = { key: '', value: '', passthrough: false }

function RegistryPicker({
  onPick,
}: {
  onPick: (entry: McpCatalogEntry, install: McpInstallOption) => void
}) {
  const t = useT()
  const [term, setTerm] = useState('')
  const [kind, setKind] = useState<RegistryFilter>('all')
  const [page, setPage] = useState<McpRegistryPage | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    const timer = window.setTimeout(() => {
      void mcpRegistrySearch(term.trim() || undefined)
        .then((next) => {
          if (cancelled) return
          setPage(next)
          setState('idle')
        })
        .catch(() => {
          if (cancelled) return
          setPage(null)
          setState('error')
        })
    }, 320)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [term])

  const entries = (page?.entries ?? []).filter((entry) =>
    kind === 'all'
      ? true
      : entry.installs.some((install) =>
          kind === 'local' ? install.kind === 'stdio' : install.kind !== 'stdio',
        ),
  )

  return (
    <div className={styles.registry}>
      <div className={styles.field}>
        <input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('mcp.registrySearch')}
          aria-label={t('mcp.registrySearch')}
        />
      </div>

      <div className={styles.registryToolbar}>
        <div className={styles.segmented} role="group" aria-label={t('mcp.registryFilter')}>
          {(['all', 'local', 'remote'] as RegistryFilter[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => setKind(option)}
            >
              {t(`mcp.registryFilter.${option}`)}
            </button>
          ))}
        </div>
        {state === 'idle' ? (
          <span className={styles.hint}>{t('mcp.registryCount', { count: entries.length })}</span>
        ) : null}
      </div>

      {page?.staleSince ? (
        <span className={styles.hint}>
          {t('mcp.registryStale', {
            date: new Date(page.staleSince).toLocaleDateString(),
          })}
        </span>
      ) : null}

      {state === 'error' ? (
        <span className={styles.hint}>{t('mcp.registryOffline')}</span>
      ) : state === 'loading' ? (
        <span className={styles.hint}>{t('mcp.registryLoading')}</span>
      ) : entries.length > 0 ? (
        <div className={styles.registryList}>
          {entries.map((entry) => (
            <div key={entry.id} className={styles.registryEntry}>
              <div className={styles.registryHead}>
                <b>{entry.title}</b>
                <span className={styles.registryVersion}>{entry.version}</span>
              </div>
              <p className={styles.registryDescription}>{entry.description}</p>
              <div className={styles.registryInstalls}>
                {entry.installs.map((install) => (
                  <button
                    key={`${install.kind}:${install.label}`}
                    type="button"
                    className={styles.registryInstall}
                    onClick={() => onPick(entry, install)}
                    title={install.label}
                  >
                    {install.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <span className={styles.hint}>{t('mcp.registryNoResults')}</span>
      )}
    </div>
  )
}

export function AddServerFlow({
  scope,
  repo,
  capabilities,
  availableAgents,
  initialSource = 'registry',
  onClose,
  onDone,
}: Props) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)

  const [source, setSource] = useState<Source>(initialSource)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TransportKind>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [rows, setRows] = useState<EnvRow[]>([EMPTY_ROW])
  const [paste, setPaste] = useState('')
  const [targets, setTargets] = useState<McpAgent[]>(availableAgents)
  const [busy, setBusy] = useState(false)

  const manualServer: McpServerInput | null = useMemo(() => {
    const envInputs: McpEnvInput[] = rows
      .filter((row) => row.key.trim().length > 0)
      .map((row) =>
        row.passthrough
          ? { key: row.key.trim(), passthroughFrom: (row.value.trim() || row.key).trim() }
          : { key: row.key.trim(), value: row.value },
      )
    const trimmedName = name.trim()
    if (!trimmedName) return null
    if (kind === 'stdio') {
      if (!command.trim()) return null
      return {
        name: trimmedName,
        transport: {
          kind: 'stdio',
          command: command.trim(),
          args: args
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          cwd: null,
        },
        env: envInputs,
      }
    }
    if (!url.trim()) return null
    return {
      name: trimmedName,
      transport: { kind, url: url.trim(), headers: [] },
      env: envInputs,
    }
  }, [name, kind, command, args, url, rows])

  const pasted = source === 'paste' ? parsePastedServer(paste, name) : null
  const servers: McpServerInput[] =
    source === 'paste' ? (pasted?.ok ? pasted.servers : []) : manualServer ? [manualServer] : []

  const blockedByAgent = useMemo(() => {
    const map = new Map<McpAgent, string[]>()
    for (const agent of MCP_AGENTS) {
      const fields = servers.flatMap((server) => unsupportedFor(capabilities[agent], server))
      if (fields.length > 0) map.set(agent, [...new Set(fields)])
    }
    return map
  }, [servers, capabilities])

  const selectable = targets.filter(
    (agent) => availableAgents.includes(agent) && !blockedByAgent.has(agent),
  )
  const canSubmit = servers.length > 0 && selectable.length > 0 && !busy

  const toggleTarget = (agent: McpAgent) =>
    setTargets((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    )

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    const written: string[] = []
    const failed: string[] = []
    for (const agent of selectable) {
      for (const server of servers) {
        try {
          await mcpUpsert(agent, scope, repo, server)
          written.push(AGENT_TYPE_LABELS[agent])
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error)
          failed.push(`${AGENT_TYPE_LABELS[agent]}: ${t(mcpErrorKey(raw))}`)
        }
      }
    }
    setBusy(false)
    if (written.length > 0) {
      pushToast({
        title: t('mcp.addWritten', {
          count: servers.length,
          agents: [...new Set(written)].join(', '),
        }),
        body: servers.map((server) => server.name).join(', '),
      })
    }
    if (failed.length > 0) {
      pushToast({ title: t('mcp.writeFailed'), body: failed.join(' · ') })
    }
    onDone()
    onClose()
  }

  return (
    <Modal
      nested
      open
      onClose={onClose}
      title={t('mcp.addTitle')}
      width={620}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {selectable.length > 0
              ? t('mcp.addActionCount', { count: selectable.length })
              : t('mcp.addAction')}
          </button>
        </>
      }
    >
      <div className={controls.tabRow} role="tablist">
        {(['manual', 'paste', 'registry'] as Source[]).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={source === option}
            className={`${controls.tabBtn} ${source === option ? controls.tabBtnActive : ''}`}
            onClick={() => setSource(option)}
          >
            {t(
              option === 'manual'
                ? 'mcp.addManual'
                : option === 'paste'
                  ? 'mcp.addPaste'
                  : 'mcp.addRegistry',
            )}
          </button>
        ))}
      </div>

      {source === 'registry' ? (
        <RegistryPicker
          onPick={(entry, install) => {
            setName(entry.suggestedName)
            if (install.kind === 'stdio') {
              setKind('stdio')
              setCommand(install.command ?? '')
              setArgs(install.args.join('\n'))
            } else {
              setKind(install.kind)
              setUrl(install.url ?? '')
            }
            const hints = install.kind === 'stdio' ? install.env : install.headers
            setRows(
              hints.length > 0
                ? hints.map((hint) => ({
                    key: hint.name,
                    value: hint.secret ? '' : (hint.default ?? ''),
                    passthrough: false,
                  }))
                : [EMPTY_ROW],
            )
            setSource('manual')
          }}
        />
      ) : null}

      <div className={styles.form} hidden={source === 'registry'}>
        <label className={styles.field}>
          <span>{t('mcp.fieldName')}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="playwright"
            data-autofocus
          />
        </label>

        {source === 'manual' ? (
          <>
            <div className={styles.segmented} role="group" aria-label={t('mcp.fieldTransport')}>
              {(['stdio', 'http', 'sse'] as TransportKind[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => setKind(option)}
                >
                  {option}
                </button>
              ))}
            </div>

            {kind === 'stdio' ? (
              <>
                <label className={styles.field}>
                  <span>{t('mcp.fieldCommand')}</span>
                  <input
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="npx"
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('mcp.fieldArgs')}</span>
                  <textarea
                    rows={3}
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                    placeholder={'-y\n@playwright/mcp@latest'}
                  />
                </label>
              </>
            ) : (
              <label className={styles.field}>
                <span>{t('mcp.fieldUrl')}</span>
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                />
              </label>
            )}

            <div className={styles.field}>
              <span>{t('mcp.fieldEnv')}</span>
              <div className={styles.envRows}>
                {rows.map((row, index) => (
                  <div key={index} className={styles.envRow}>
                    <input
                      value={row.key}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item, position) =>
                            position === index ? { ...item, key: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder="API_KEY"
                      aria-label={t('mcp.fieldEnvKey')}
                    />
                    <input
                      value={row.value}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item, position) =>
                            position === index ? { ...item, value: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder={row.passthrough ? t('mcp.fieldEnvFrom') : t('mcp.fieldEnvValue')}
                      aria-label={t('mcp.fieldEnvValue')}
                    />
                    <label className={styles.checkbox} title={t('mcp.fieldPassthroughHint')}>
                      <input
                        type="checkbox"
                        checked={row.passthrough}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, position) =>
                              position === index
                                ? { ...item, passthrough: event.target.checked }
                                : item,
                            ),
                          )
                        }
                      />
                      {t('mcp.fieldPassthrough')}
                    </label>
                    <button
                      type="button"
                      className={controls.iconBtnSm}
                      onClick={() =>
                        setRows((current) =>
                          current.length === 1
                            ? [EMPTY_ROW]
                            : current.filter((_, position) => position !== index),
                        )
                      }
                      aria-label={t('common.remove')}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={controls.btnLink}
                  onClick={() => setRows((current) => [...current, { ...EMPTY_ROW }])}
                >
                  <Plus size={12} />
                  {t('mcp.addEnvRow')}
                </button>
              </div>
            </div>
          </>
        ) : (
          <label className={styles.field}>
            <span>{t('mcp.fieldPaste')}</span>
            <textarea
              rows={9}
              className={styles.mono}
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              placeholder={
                '{\n  "mcpServers": {\n    "playwright": {\n      "command": "npx",\n      "args": ["@playwright/mcp@latest"]\n    }\n  }\n}'
              }
            />
            <span className={styles.hint}>
              {paste.trim().length === 0
                ? t('mcp.pasteHint')
                : pasted?.ok
                  ? t('mcp.pasteFound', { count: pasted.servers.length })
                  : t(pasted?.error ?? 'mcp.pasteInvalidJson')}
            </span>
          </label>
        )}

        <div className={`${styles.field} ${styles.targetsBlock}`}>
          <span>{t('mcp.fieldTargets')}</span>
          <p className={styles.hint}>{t('mcp.fieldTargetsHint')}</p>
          <div className={styles.targets}>
            {MCP_AGENTS.map((agent) => {
              const blocked = blockedByAgent.get(agent)
              const unavailable = !availableAgents.includes(agent)
              return (
                <label
                  key={agent}
                  className={styles.target}
                  data-off={unavailable || blocked ? '1' : '0'}
                  title={
                    unavailable
                      ? t('mcp.targetUnavailable')
                      : blocked
                        ? t('mcp.targetBlocked', { fields: blocked.join(', ') })
                        : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={targets.includes(agent) && !unavailable && !blocked}
                    disabled={unavailable || Boolean(blocked)}
                    onChange={() => toggleTarget(agent)}
                  />
                  {AGENT_TYPE_LABELS[agent]}
                </label>
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}

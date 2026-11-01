import { Download, Loader2, RefreshCw, ScanLine, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { agentLabel } from '../../lib/agentProviders'
import { useT } from '../../lib/i18n'
import {
  applyToolingMcp,
  applyToolingSkill,
  captureToolingManifest,
  inspectToolingManifest,
  mergeManifests,
  removeFromManifest,
  type ToolingInspection,
  type ToolingMcpItem,
  type ToolingSkillItem,
  type ToolingStatus,
} from '../../lib/toolingManifest'
import type { AgentType, McpScope, ToolingManifest, ToolingMcpServer } from '../../lib/types'
import controls from '../modals/controls.module.css'
import styles from './ToolingManifestPanel.module.css'

type Props = {
  scope: McpScope
  repo: string | null
  manifest: ToolingManifest | undefined
  onChange: (manifest: ToolingManifest | undefined) => void
}

function transportLabel(server: ToolingMcpServer): string {
  if (server.transport.kind === 'stdio') {
    return [server.transport.command, ...server.transport.args].filter(Boolean).join(' ')
  }
  return server.transport.url
}

function itemKey(kind: 'mcp' | 'skill', agent: string, name: string): string {
  return `${kind}:${agent}:${name}`
}

export function ToolingManifestPanel({ scope, repo, manifest, onChange }: Props) {
  const t = useT()
  const [inspection, setInspection] = useState<ToolingInspection | null>(null)
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [secretsFor, setSecretsFor] = useState<string | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!manifest) {
      setInspection(null)
      return
    }
    setLoading(true)
    try {
      setInspection(await inspectToolingManifest(manifest, scope, repo))
    } catch (err) {
      setError(t('tooling.inspectError', { error: String(err) }))
    } finally {
      setLoading(false)
    }
  }, [manifest, scope, repo, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const capture = async () => {
    setCapturing(true)
    setError(null)
    try {
      const captured = await captureToolingManifest(scope, repo)
      onChange(manifest ? mergeManifests(manifest, captured) : captured)
    } catch (err) {
      setError(t('tooling.captureError', { error: String(err) }))
    } finally {
      setCapturing(false)
    }
  }

  const install = async (key: string, run: () => Promise<void>) => {
    setInstalling(key)
    setError(null)
    try {
      await run()
      setSecretsFor(null)
      setSecrets({})
      await refresh()
    } catch (err) {
      setError(t('tooling.installError', { error: String(err) }))
    } finally {
      setInstalling(null)
    }
  }

  const installMcp = (item: ToolingMcpItem) => {
    const key = itemKey('mcp', item.server.agent, item.server.name)
    if (item.secretFields.length > 0 && secretsFor !== key) {
      setSecretsFor(key)
      setSecrets({})
      return
    }
    void install(key, () => applyToolingMcp(item.server, scope, repo, secrets))
  }

  const installAllWithoutSecrets = async () => {
    if (!inspection) return
    setInstalling('all')
    setError(null)
    try {
      for (const item of inspection.mcp) {
        if (item.status === 'missing' && item.secretFields.length === 0) {
          await applyToolingMcp(item.server, scope, repo, {})
        }
      }
      for (const item of inspection.skills) {
        if (item.status === 'missing') await applyToolingSkill(item.skill)
      }
      await refresh()
    } catch (err) {
      setError(t('tooling.installError', { error: String(err) }))
    } finally {
      setInstalling(null)
    }
  }

  const unlink = (kind: 'mcp' | 'skill', agent: string, name: string) => {
    if (!manifest) return
    const next = removeFromManifest(manifest, { kind, agent, name })
    onChange(next.mcpServers.length === 0 && next.skills.length === 0 ? undefined : next)
  }

  const statusLabel = (status: ToolingStatus) =>
    status === 'installed'
      ? t('tooling.statusInstalled')
      : status === 'missing'
        ? t('tooling.statusMissing')
        : t('tooling.statusUnavailable')

  const quickInstallable =
    inspection?.mcp.some((i) => i.status === 'missing' && i.secretFields.length === 0) ||
    inspection?.skills.some((i) => i.status === 'missing')

  const renderMcp = (item: ToolingMcpItem) => {
    const key = itemKey('mcp', item.server.agent, item.server.name)
    const askingSecrets = secretsFor === key
    const ready = item.secretFields.every((field) => secrets[field.id]?.trim())
    return (
      <li key={key} className={styles.row}>
        <div className={styles.rowMain}>
          <span className={styles.agent}>{agentLabel(item.server.agent as AgentType)}</span>
          <span className={styles.name}>{item.server.name}</span>
          <span className={styles.detail} title={transportLabel(item.server)}>
            {transportLabel(item.server)}
          </span>
          <span className={`${styles.status} ${styles[item.status]}`}>
            {statusLabel(item.status)}
          </span>
          {item.status === 'missing' ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm}`}
              disabled={installing !== null}
              onClick={() => installMcp(item)}
            >
              {installing === key ? <Loader2 size={12} className={styles.spin} /> : null}
              {t('tooling.install')}
            </button>
          ) : null}
          <button
            type="button"
            className={controls.iconBtnSm}
            title={t('tooling.unlink')}
            aria-label={t('tooling.unlink')}
            onClick={() => unlink('mcp', item.server.agent, item.server.name)}
          >
            <X size={12} />
          </button>
        </div>
        {askingSecrets ? (
          <div className={styles.secrets}>
            <p className={styles.hint}>{t('tooling.secretsHint')}</p>
            {item.secretFields.map((field) => (
              <label key={field.id} className={styles.secretField}>
                <span>
                  {field.location === 'header'
                    ? t('tooling.secretHeader', { key: field.key })
                    : field.key}
                </span>
                <input
                  className={controls.input}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secrets[field.id] ?? ''}
                  onChange={(e) => setSecrets((prev) => ({ ...prev, [field.id]: e.target.value }))}
                />
              </label>
            ))}
            <div className={styles.secretActions}>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnSm}`}
                onClick={() => setSecretsFor(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnSm} ${controls.btnPrimary}`}
                disabled={!ready || installing !== null}
                onClick={() => installMcp(item)}
              >
                {t('tooling.install')}
              </button>
            </div>
          </div>
        ) : null}
      </li>
    )
  }

  const renderSkill = (item: ToolingSkillItem) => {
    const key = itemKey('skill', item.skill.agent, item.skill.name)
    return (
      <li key={key} className={styles.row}>
        <div className={styles.rowMain}>
          <span className={styles.agent}>{agentLabel(item.skill.agent as AgentType)}</span>
          <span className={styles.name}>{item.skill.name}</span>
          <span className={styles.detail}>
            {item.status === 'unavailable' ? t('tooling.skillUnavailableHint') : ''}
          </span>
          <span className={`${styles.status} ${styles[item.status]}`}>
            {statusLabel(item.status)}
          </span>
          {item.status === 'missing' ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm}`}
              disabled={installing !== null}
              onClick={() => void install(key, () => applyToolingSkill(item.skill))}
            >
              {installing === key ? <Loader2 size={12} className={styles.spin} /> : null}
              {t('tooling.install')}
            </button>
          ) : null}
          <button
            type="button"
            className={controls.iconBtnSm}
            title={t('tooling.unlink')}
            aria-label={t('tooling.unlink')}
            onClick={() => unlink('skill', item.skill.agent, item.skill.name)}
          >
            <X size={12} />
          </button>
        </div>
      </li>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          disabled={capturing}
          onClick={() => void capture()}
        >
          {capturing ? <Loader2 size={12} className={styles.spin} /> : <ScanLine size={12} />}
          {t('tooling.capture')}
        </button>
        {manifest ? (
          <button
            type="button"
            className={`${controls.btn} ${controls.btnSm}`}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={12} className={loading ? styles.spin : undefined} />
            {t('tooling.refresh')}
          </button>
        ) : null}
        {quickInstallable ? (
          <button
            type="button"
            className={`${controls.btn} ${controls.btnSm} ${controls.btnPrimary}`}
            disabled={installing !== null}
            onClick={() => void installAllWithoutSecrets()}
          >
            {installing === 'all' ? (
              <Loader2 size={12} className={styles.spin} />
            ) : (
              <Download size={12} />
            )}
            {t('tooling.installAll')}
          </button>
        ) : null}
      </div>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {!manifest ? (
        <p className={styles.empty}>{t('tooling.empty')}</p>
      ) : (
        <>
          <section>
            <h4 className={styles.sectionTitle}>
              {t('tooling.mcpTitle', { count: manifest.mcpServers.length })}
            </h4>
            {inspection && inspection.mcp.length > 0 ? (
              <ul className={styles.list}>{inspection.mcp.map(renderMcp)}</ul>
            ) : (
              <p className={styles.empty}>{t('tooling.mcpEmpty')}</p>
            )}
          </section>
          {scope === 'global' ? (
            <section>
              <h4 className={styles.sectionTitle}>
                {t('tooling.skillsTitle', { count: manifest.skills.length })}
              </h4>
              {inspection && inspection.skills.length > 0 ? (
                <ul className={styles.list}>{inspection.skills.map(renderSkill)}</ul>
              ) : (
                <p className={styles.empty}>{t('tooling.skillsEmpty')}</p>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

import {
  ChevronsDown,
  Coins,
  Compass,
  Flame,
  Gauge,
  GitBranch,
  LifeBuoy,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  Network,
  PiggyBank,
  Plus,
  Route,
  Scale,
  ShieldCheck,
  Trophy,
  User,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { getCachedCodexUsage } from '../../../../lib/codexUsageCache'
import { type MessageKey, useT } from '../../../../lib/i18n'
import {
  BUDGETS,
  CHECKS,
  ON_BOTH_CRITICAL,
  ROUTES,
  SPENT_STEPS,
  type TaskId,
  TASKS,
} from '../../../../lib/playbooks/catalog'
import { type DocPort, removeEdge, removeNode } from '../../../../lib/playbooks/flowDoc'
import {
  addPlaybook,
  applyDoc,
  buildDocView,
  hasProblems,
  saveLayout,
} from '../../../../lib/playbooks/flowView'
import { buildGraph } from '../../../../lib/playbooks/graph'
import { readLiveUsage } from '../../../../lib/playbooks/liveUsage'
import { formatUsd } from '../../../../lib/playbooks/prices'
import {
  activeOrder,
  applyLiveUsage,
  isEdited,
  lowProviders,
  type PlaybooksState,
  providerLabel,
  routedVia,
  toYaml,
  type Workflow,
  workflowNow,
} from '../../../../lib/playbooks/state'
import {
  getClaudeUsage,
  orchestratorSavePlaybooks,
  type SkillPlaybooks,
} from '../../../../lib/tauri'
import { isLightTheme, useAppliedTheme } from '../../../../lib/themes'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useUiStore } from '../../../../stores/uiStore'
import { PlaybooksContext } from './context'
import { Select } from './fields'
import { FlowCanvas } from './FlowCanvas'
import { CHECK_KEYS, Inspector, routingName, taskLabel } from './Inspector'
import { NodeCanvas } from './NodeCanvas'
import styles from './Playbooks.module.css'
import { ProviderMark } from './ProviderMark'
import { UsageBar } from './UsageBar'

const WORKFLOW_ICONS: Record<string, LucideIcon> = {
  complete: Route,
  direct: User,
  cascade: ChevronsDown,
  'scout-then-build': Compass,
  'plan-big-execute-small': Network,
  'audit-at-scale': ListChecks,
  'parallel-worktrees': GitBranch,
  'plan-execute': ListOrdered,
  'advisor-escalation': LifeBuoy,
  'best-of-n': Trophy,
  'review-gate': ShieldCheck,
  economy: Coins,
  balanced: Scale,
  performance: Gauge,
}

const PROFILE_ICONS: Record<string, LucideIcon> = {
  base: Scale,
  savings: PiggyBank,
  aggressive: Flame,
}

const BUDGET_KEYS: Record<string, MessageKey> = {
  ok: 'playbooks.budget.ok',
  low: 'playbooks.budget.low',
}
const BOTH_KEYS: Record<string, MessageKey> = {
  ask: 'playbooks.both.ask',
  'run-cheapest': 'playbooks.both.runCheapest',
  block: 'playbooks.both.block',
}

export function PlaybooksEditor({
  file,
  initial,
  onSaved,
  onDiscard,
}: {
  file: SkillPlaybooks
  initial: PlaybooksState
  onSaved: (file: SkillPlaybooks) => void
  onDiscard: () => void
}) {
  const t = useT()
  const uiTheme = useProjectsStore((state) => state.preferences.uiTheme)
  const appliedTheme = useAppliedTheme(uiTheme)
  const claudeAccess = useProjectsStore((state) => state.preferences.usageAccess.claude)
  const codexAccess = useProjectsStore((state) => state.preferences.usageAccess.codex)
  const pushToast = useUiStore((state) => state.pushToast)
  const [s] = useState(initial)
  const [, setVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [info, setInfo] = useState(false)
  const [yamlOpen, setYamlOpen] = useState(false)
  const [pulse, setPulse] = useState(0)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const bump = () => setVersion((value) => value + 1)
  const animate = () => setPulse((value) => value + 1)
  const touch = (global = false) => {
    const current = workflowNow(s)
    if (global) s.globalEdited = true
    else current.edited = true
    if (current.kind === 'playbook') applyDoc(current)
    bump()
  }

  useEffect(() => {
    let live = true
    void readLiveUsage({
      claude: claudeAccess ? getClaudeUsage : undefined,
      codex: codexAccess ? getCachedCodexUsage : undefined,
    }).then((usage) => {
      if (!live) return
      applyLiveUsage(s, usage)
      setVersion((value) => value + 1)
    })
    return () => {
      live = false
    }
  }, [s, claudeAccess, codexAccess])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const wf = workflowNow(s)
  const docView = wf.kind === 'playbook' && wf.doc ? buildDocView(s, t, wf) : null
  const graph = docView ?? buildGraph(s, t, wf)
  const edited = isEdited(s)
  const blocked = hasProblems(s)
  const problems = wf.kind === 'playbook' ? (wf.problems ?? []) : []
  const playbooks = Object.values(s.workflows).filter((w) => w.kind === 'playbook')
  const routing = Object.values(s.workflows).filter((w) => w.kind === 'routing')
  const title =
    wf.kind === 'playbook'
      ? wf.pb.name
      : t('playbooks.routingName', { name: routingName(t, wf.key) })
  const panelOpen = Boolean(selectedId) || info

  const openWorkflow = (w: Workflow) => {
    s.wf = w.id
    if (w.kind === 'routing') s.routingWf = w.id
    setSelectedId(null)
    animate()
    bump()
  }

  const scenario = (apply: () => void) => {
    apply()
    animate()
    bump()
  }

  const removeSelection = () => {
    if (wf.kind !== 'playbook' || !wf.doc || !selectedId) return
    if (selectedId.startsWith('edge:')) {
      const [from, port, to] = selectedId.slice(5).split('|')
      removeEdge(wf.doc, { from, port: port as DocPort, to })
    } else {
      const node = wf.doc.nodes.find((n) => n.id === selectedId)
      if (!node || node.kind === 'start' || node.kind === 'end') return
      removeNode(wf.doc, node.id)
    }
    setSelectedId(null)
    touch()
  }

  const save = async () => {
    setSaving(true)
    try {
      const saved = await orchestratorSavePlaybooks(toYaml(s))
      Object.values(s.workflows).forEach((w) => {
        w.edited = false
        if (w.kind === 'playbook') saveLayout(w)
      })
      s.globalEdited = false
      onSaved(saved)
      bump()
      pushToast({ title: t('playbooks.saved'), body: saved.path })
    } catch (error) {
      pushToast({ title: t('playbooks.saveFailed'), body: String(error) })
    } finally {
      setSaving(false)
    }
  }

  const workflowButton = (w: Workflow) => {
    const Icon = WORKFLOW_ICONS[w.key] ?? Route
    const name = w.kind === 'playbook' ? w.pb.name : routingName(t, w.key)
    const count = w.kind === 'playbook' ? w.pb.phases.length : w.rules.length
    return (
      <button
        key={w.id}
        type="button"
        className={styles.wf}
        title={(w.kind === 'playbook' ? w.pb.pickWhen : undefined) ?? name}
        aria-current={w.id === s.wf}
        onClick={() => openWorkflow(w)}
      >
        <span className={styles.ico}>
          <Icon size={14} />
        </span>
        <span className={styles.wfName}>{name}</span>
        {w.edited ? <span className={styles.editedDot} /> : null}
        <span className={styles.wfCount}>{count}</span>
      </button>
    )
  }

  const allLow = activeOrder(s).every((id) => lowProviders(s).includes(id))
  const profileName = (key: string) => s.profiles[key]?.name ?? key

  return (
    <PlaybooksContext.Provider
      value={{
        s,
        t,
        theme: uiTheme,
        lightTheme: isLightTheme(appliedTheme),
        touch,
        redraw: bump,
        select: setSelectedId,
        selectedId,
      }}
    >
      <div className={styles.editor}>
        <header className={styles.toolbar}>
          <span className={styles.crumbLabel}>{t('playbooks.crumb')}</span>
          <span className={styles.crumb}>/</span>
          <span className={styles.crumbCurrent}>{title}</span>
          {edited ? <span className={styles.editedDot} title={t('playbooks.edited')} /> : null}
          <span className={styles.spacer} />
          <div className={styles.profiles} role="group" aria-label={t('playbooks.profiles')}>
            {Object.entries(s.profiles).map(([key, profile]) => {
              const Icon = PROFILE_ICONS[key] ?? Route
              return (
                <button
                  key={key}
                  type="button"
                  title={profile.summary ?? ''}
                  aria-pressed={key === s.profile}
                  onClick={() => {
                    if (key === s.profile) return
                    s.profile = key
                    s.globalEdited = true
                    animate()
                    bump()
                  }}
                >
                  <Icon size={13} />
                  {profileName(key).toLowerCase()}
                </button>
              )
            })}
          </div>
          <UsageBar
            onChange={() => {
              animate()
              bump()
            }}
          />
          <button
            type="button"
            className={styles.toolbarButton}
            aria-pressed={info && !selectedId}
            onClick={() => {
              setInfo(!(info && !selectedId))
              setSelectedId(null)
            }}
          >
            {t('playbooks.details')}
          </button>
        </header>

        <nav className={styles.sidebar} aria-label={t('playbooks.sidebarTitle')}>
          <div className={styles.sideHeader}>
            <span className={styles.sideLabel}>{t('playbooks.sidebarTitle')}</span>
            <span className={styles.count}>{playbooks.length + routing.length}</span>
          </div>
          <div className={styles.sideList}>
            <div className={styles.group}>
              <div className={styles.groupTitle}>
                <span className={styles.groupDot} data-tone="on" />
                {t('playbooks.groupStrategies')}
                <button
                  type="button"
                  className={styles.groupAdd}
                  aria-label={t('playbooks.newPlaybook')}
                  title={t('playbooks.newPlaybook')}
                  onClick={() => {
                    const added = addPlaybook(s, t('playbooks.newPlaybookName'))
                    s.wf = added.id
                    setSelectedId(null)
                    setInfo(true)
                    animate()
                    bump()
                  }}
                >
                  <Plus size={12} />
                </button>
              </div>
              {playbooks.map(workflowButton)}
            </div>
            <div className={styles.group}>
              <div className={styles.groupTitle}>
                <span className={styles.groupDot} data-tone="accent" />
                {t('playbooks.groupRouting')}
              </div>
              {routing.map(workflowButton)}
            </div>
            <div className={styles.group}>
              <div className={styles.groupTitle}>
                <span className={styles.groupDot} data-tone="muted" />
                {t('playbooks.groupProviders')}
                <span className={styles.groupNote}>{profileName(s.profile)}</span>
              </div>
              {activeOrder(s).map((id, i) => {
                const via = routedVia(s, id)
                return (
                  <button
                    key={id}
                    type="button"
                    className={styles.wf}
                    aria-current={selectedId === `provider:${id}`}
                    onClick={() => setSelectedId(`provider:${id}`)}
                  >
                    <span className={styles.ico}>
                      <ProviderMark id={id} size={13} />
                    </span>
                    <span className={styles.wfName}>{providerLabel(s, id)}</span>
                    {via ? (
                      <span
                        className={styles.via}
                        title={t('playbooks.throughRoute', { route: ROUTES[via]?.label ?? via })}
                      >
                        <ProviderMark id={via} size={11} />
                      </span>
                    ) : null}
                    <span className={styles.wfCount}>{i + 1}</span>
                  </button>
                )
              })}
              {Object.entries(s.routes).map(([rid, route]) => (
                <button
                  key={rid}
                  type="button"
                  className={styles.wf}
                  aria-current={selectedId === `route:${rid}`}
                  onClick={() => setSelectedId(`route:${rid}`)}
                >
                  <span className={styles.ico}>
                    <ProviderMark id={rid} size={13} />
                  </span>
                  <span className={styles.wfName}>{ROUTES[rid]?.label ?? rid}</span>
                  <span className={styles.wfCount}>
                    {route.running ? t('playbooks.on') : t('playbooks.off')}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className={styles.sideFooter}>
            <div className={styles.footerRow}>
              <span className={styles.footerLabel}>{t('playbooks.fileLabel')}</span>
              <button
                type="button"
                className={styles.toolbarButton}
                aria-pressed={yamlOpen}
                onClick={() => setYamlOpen(!yamlOpen)}
              >
                alethe-playbooks.yaml
              </button>
            </div>
            <p className={styles.fileNote} title={file.path}>
              {file.custom ? t('playbooks.sourceCustom') : t('playbooks.sourceBundled')}
            </p>
            <div className={styles.saveRow}>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                disabled={!edited || saving || blocked}
                title={blocked ? t('playbooks.saveBlocked') : undefined}
                onClick={() => void save()}
              >
                {saving ? t('playbooks.saving') : t('playbooks.save')}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={!edited || saving}
                onClick={onDiscard}
              >
                {t('playbooks.discard')}
              </button>
            </div>
          </div>
        </nav>

        <section className={styles.stage}>
          {wf.kind === 'playbook' && docView ? (
            <NodeCanvas
              key={wf.id}
              wf={wf}
              view={docView}
              pulse={pulse}
              reserved={yamlOpen}
              onStructure={() => touch()}
            />
          ) : (
            <FlowCanvas
              graph={graph}
              fitKey={s.wf}
              pulse={pulse}
              reserved={yamlOpen}
              onMove={(id, position) => {
                wf.positions[id] = position
                bump()
              }}
            />
          )}
          {problems.length ? (
            <button
              type="button"
              className={styles.problemBanner}
              onClick={() => setSelectedId(problems[0].node)}
            >
              {t('playbooks.problemBanner', { count: problems.length })}
            </button>
          ) : null}
          <div className={styles.scenarioBar}>
            <label className={styles.scenarioItem}>
              <span>{t('playbooks.scenarioTask')}</span>
              <Select
                className={styles.scenarioSelect}
                value={s.task}
                ariaLabel={t('playbooks.scenarioTask')}
                options={(Object.keys(TASKS) as TaskId[]).map((task) => ({
                  value: task,
                  label: taskLabel(t, task),
                }))}
                onChange={(value) =>
                  scenario(() => {
                    s.task = value as TaskId
                  })
                }
              />
            </label>
            <span className={styles.divider} />
            <label className={styles.scenarioItem}>
              <span>{t('playbooks.scenarioChecks')}</span>
              <Select
                className={styles.scenarioSelect}
                value={s.checks}
                ariaLabel={t('playbooks.scenarioChecks')}
                options={CHECKS.map((check) => ({ value: check, label: t(CHECK_KEYS[check]) }))}
                onChange={(value) =>
                  scenario(() => {
                    s.checks = value as PlaybooksState['checks']
                  })
                }
              />
            </label>
            <span className={styles.divider} />
            <label className={styles.scenarioItem}>
              <span>{t('playbooks.scenarioBudget')}</span>
              <Select
                className={styles.scenarioSelect}
                value={s.budget}
                ariaLabel={t('playbooks.scenarioBudget')}
                options={BUDGETS.map((budget) => ({
                  value: budget,
                  label: t(BUDGET_KEYS[budget]),
                }))}
                onChange={(value) =>
                  scenario(() => {
                    s.budget = value as PlaybooksState['budget']
                  })
                }
              />
            </label>
            <span className={styles.divider} />
            <label className={styles.scenarioItem}>
              <span>{t('playbooks.scenarioSpent')}</span>
              <Select
                className={styles.scenarioSelect}
                value={String(s.spent)}
                ariaLabel={t('playbooks.scenarioSpent')}
                options={SPENT_STEPS.map((amount) => ({
                  value: String(amount),
                  label: formatUsd(amount),
                }))}
                onChange={(value) =>
                  scenario(() => {
                    s.spent = Number(value)
                  })
                }
              />
            </label>
            {allLow ? (
              <>
                <span className={styles.divider} />
                <label className={styles.scenarioItem}>
                  <span>{t('playbooks.scenarioAllLow')}</span>
                  <Select
                    className={styles.scenarioSelect}
                    value={s.quota.onBothCritical}
                    ariaLabel={t('playbooks.scenarioAllLow')}
                    options={ON_BOTH_CRITICAL.map((value) => ({
                      value,
                      label: t(BOTH_KEYS[value]),
                    }))}
                    onChange={(value) => {
                      s.quota.onBothCritical = value
                      touch(true)
                    }}
                  />
                </label>
              </>
            ) : null}
          </div>
          {yamlOpen ? (
            <div className={styles.drawer}>
              <header>
                <b>alethe-playbooks.yaml</b>
                <span>{t('playbooks.drawerHint')}</span>
                <span className={styles.spacer} />
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    void navigator.clipboard?.writeText(toYaml(s)).then(() => setCopied(true))
                  }}
                >
                  {copied ? t('playbooks.copied') : t('playbooks.copy')}
                </button>
              </header>
              <pre>{toYaml(s)}</pre>
            </div>
          ) : null}
          {panelOpen ? (
            <Inspector
              graph={graph}
              onDelete={removeSelection}
              onClose={() => {
                setSelectedId(null)
                setInfo(false)
              }}
            />
          ) : null}
        </section>
      </div>
    </PlaybooksContext.Provider>
  )
}

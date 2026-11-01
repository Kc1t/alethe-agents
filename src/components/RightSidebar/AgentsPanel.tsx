import { Bot, Check, ChevronRight, FolderX, Maximize2, Square, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useFocusedPlannerPtyId } from '../../hooks/useAgentsSidebarAutoOpen'
import { useSidebarChatTitle } from '../../hooks/useSidebarChatTitle'
import { COST_POLL_MS } from '../../lib/agentCanvasConfig'
import {
  type AgentsPlannerGroup,
  type AgentsProjectGroup,
  groupAgentJobs,
  sumJobCost,
} from '../../lib/agentsPanelGroups'
import { fmtUsd } from '../../lib/costFormat'
import { useT } from '../../lib/i18n'
import { nativeSubagentJobs } from '../../lib/orchestratorSubagents'
import {
  listenOrchestratorJobs,
  orchestratorAnswer,
  orchestratorCancelJob,
  type OrchestratorDecision,
  type OrchestratorJob,
  orchestratorJobs,
  type OrchestratorJobStatus,
  type OrchestratorSnapshot,
} from '../../lib/tauri/orchestrator'
import { sidebarTerminalDisplayName } from '../../lib/terminalFactory'
import type { Project, Theme } from '../../lib/types'
import { useAgentCanvasStore } from '../../stores/agentCanvasStore'
import { useNodeCostStore } from '../../stores/nodeCostStore'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentGlyph, formatElapsed } from '../OrchestratorPane/nodeFormat'
import { Monogram } from '../ProjectSidebar/normalSidebarPrimitives'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './AgentsPanel.module.css'

const LIVE_TICK_MS = 1_000

const LIVE_STATUSES: ReadonlySet<OrchestratorJobStatus> = new Set(['queued', 'running', 'blocked'])

function jobTitle(job: OrchestratorJob): string {
  const firstLine = job.spec
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine || job.runLabel || job.id
}

function useRevealTerminal() {
  const openTerminalWorkspace = useProjectsStore((s) => s.openTerminalWorkspace)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const setActiveView = useUiStore((s) => s.setActiveView)
  return (projectId: string, terminalId: string) => {
    openTerminalWorkspace(projectId, terminalId)
    setActiveTerminal(projectId, terminalId)
    requestPaneFocus(terminalId)
    setActiveView('workspace')
  }
}

function useOpenBoard() {
  const createOrchestratorPane = useProjectsStore((s) => s.createOrchestratorPane)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const reveal = useRevealTerminal()
  return (project: Project) => {
    const existing = project.terminals.find((terminal) => terminal.kind === 'orchestrator')
    if (existing) {
      reveal(project.id, existing.id)
      return
    }
    createOrchestratorPane(project.id, project.defaultCwd ?? project.terminals[0]?.cwd ?? '')
    setActiveView('workspace')
  }
}

export function AgentsPanel() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot | null>(null)
  const plannerPtyId = useFocusedPlannerPtyId()
  const [showAll, setShowAll] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const subagentNodes = useAgentCanvasStore((s) => s.nodes)
  const nodeCosts = useNodeCostStore((s) => s.byNodeId)
  const projects = useProjectsStore((s) => s.projects)
  const activeProject = useProjectsStore(selectActiveProject)
  const theme = useProjectsStore((s) => s.preferences.uiTheme)
  const openBoard = useOpenBoard()
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    void orchestratorJobs()
      .then((initial) => {
        if (!cancelled) setSnapshot(initial)
      })
      .catch(() => {})

    void listenOrchestratorJobs((next) => {
      if (!cancelled) setSnapshot(next)
    }).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => setShowAll(false), [plannerPtyId])

  const busy = (snapshot?.running ?? 0) > 0 || subagentNodes.some((n) => n.status === 'running')
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setTick((value) => value + 1), LIVE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [busy])

  useEffect(() => {
    if (!subagentNodes.some((node) => node.transcriptPath)) return
    const refresh = () => void useNodeCostStore.getState().refresh(subagentNodes)
    refresh()
    const timer = window.setInterval(refresh, COST_POLL_MS)
    return () => window.clearInterval(timer)
  }, [subagentNodes])

  const scoped = plannerPtyId !== null && !showAll

  const jobs = useMemo(() => {
    const native = nativeSubagentJobs(subagentNodes, nodeCosts)
    const all = native.length > 0 ? [...(snapshot?.jobs ?? []), ...native] : (snapshot?.jobs ?? [])
    const visible = all.filter((job) => !job.supersededBy)
    return scoped ? visible.filter((job) => job.plannerId === plannerPtyId) : visible
  }, [snapshot, subagentNodes, nodeCosts, plannerPtyId, scoped])

  const groups = useMemo(
    () => groupAgentJobs(jobs, projects, snapshot?.planners ?? [], activeProject?.id ?? null),
    [jobs, projects, snapshot?.planners, activeProject?.id],
  )

  const runningCount = jobs.filter((job) => job.status === 'running').length
  const waitingCount = jobs.filter((job) => job.status === 'blocked').length
  const queuedCount = jobs.filter((job) => job.status === 'queued').length
  const totalCost = sumJobCost(jobs)

  const toggleProject = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <section className={styles.panel} aria-label={t('agentsPanel.title')}>
      <header className={styles.header}>
        <Bot size={15} />
        <span className={styles.headerTitle}>{t('agentsPanel.title')}</span>
        <span className={styles.headerSpacer} />
        {plannerPtyId ? (
          <div className={styles.scopeSwitch} role="group" aria-label={t('agentsPanel.scopeLabel')}>
            <button
              type="button"
              className={styles.scopeOption}
              aria-pressed={!showAll}
              onClick={() => setShowAll(false)}
            >
              {t('agentsPanel.scopeFocused')}
            </button>
            <button
              type="button"
              className={styles.scopeOption}
              aria-pressed={showAll}
              onClick={() => setShowAll(true)}
            >
              {t('agentsPanel.scopeAll')}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className={styles.iconAction}
          onClick={() => activeProject && openBoard(activeProject)}
          disabled={!activeProject}
          title={t('agentsPanel.expand')}
          aria-label={t('agentsPanel.expand')}
        >
          <Maximize2 size={13} />
        </button>
      </header>

      {jobs.length > 0 ? (
        <div className={styles.summary}>
          {waitingCount > 0 ? (
            <span className={styles.summaryWaiting}>
              {t('agentsPanel.waiting', { count: waitingCount })}
            </span>
          ) : null}
          {runningCount > 0 ? (
            <span className={styles.summaryRunning}>
              {t('orchestrator.running', { count: runningCount })}
            </span>
          ) : null}
          {queuedCount > 0 ? <span>{t('orchestrator.queued', { count: queuedCount })}</span> : null}
          {waitingCount + runningCount + queuedCount === 0 ? (
            <span>{t('agentsPanel.allSettled')}</span>
          ) : null}
          {totalCost !== null ? (
            <span className={styles.summaryCost} title={t('orchestrator.costTitle')}>
              {fmtUsd(totalCost)}
            </span>
          ) : null}
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <div className={styles.empty}>
          <Bot size={20} />
          <strong>{t('agentsPanel.emptyTitle')}</strong>
          <span>{t('agentsPanel.emptyBody')}</span>
        </div>
      ) : (
        <div className={styles.list}>
          {groups.map((group) => (
            <ProjectSection
              key={group.key}
              group={group}
              theme={theme}
              collapsed={collapsed.has(group.key)}
              onToggle={() => toggleProject(group.key)}
              onOpenBoard={openBoard}
            />
          ))}
        </div>
      )}
    </section>
  )
}

type ProjectSectionProps = {
  group: AgentsProjectGroup
  theme: Theme
  collapsed: boolean
  onToggle: () => void
  onOpenBoard: (project: Project) => void
}

function ProjectSection({ group, theme, collapsed, onToggle, onOpenBoard }: ProjectSectionProps) {
  const t = useT()
  const { project } = group
  const name = project?.name ?? t('agentsPanel.noProject')

  return (
    <section className={styles.project} aria-label={name}>
      <div className={styles.projectHeader}>
        <button
          type="button"
          className={styles.projectToggle}
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <ChevronRight size={12} className={styles.chevron} data-open={!collapsed} />
          {project ? (
            <Monogram
              name={project.name}
              iconUrl={project.iconUrl}
              color={project.color}
              size={16}
            />
          ) : (
            <span className={styles.noProjectIcon} aria-hidden>
              <FolderX size={12} />
            </span>
          )}
          <span className={styles.projectName}>{name}</span>
          {group.waiting > 0 ? (
            <span
              className={styles.projectWaiting}
              title={t('agentsPanel.waiting', { count: group.waiting })}
            >
              {group.waiting}
            </span>
          ) : null}
          {group.running > 0 ? (
            <span
              className={styles.projectRunning}
              title={t('orchestrator.running', { count: group.running })}
            >
              <span className={styles.runningDot} aria-hidden />
              {group.running}
            </span>
          ) : null}
          {group.costUsd !== null ? (
            <span className={styles.projectCost} title={t('orchestrator.costTitle')}>
              {fmtUsd(group.costUsd)}
            </span>
          ) : null}
        </button>
        {project ? (
          <button
            type="button"
            className={styles.iconAction}
            onClick={() => onOpenBoard(project)}
            title={t('agentsPanel.openBoard')}
            aria-label={t('agentsPanel.openBoard')}
          >
            <Maximize2 size={12} />
          </button>
        ) : null}
      </div>
      {collapsed ? null : (
        <div className={styles.projectBody}>
          {group.planners.map((planner) => (
            <PlannerBlock
              key={planner.key}
              planner={planner}
              projectId={project?.id ?? null}
              theme={theme}
            />
          ))}
        </div>
      )}
    </section>
  )
}

type PlannerBlockProps = {
  planner: AgentsPlannerGroup
  projectId: string | null
  theme: Theme
}

function PlannerBlock({ planner, projectId, theme }: PlannerBlockProps) {
  const t = useT()
  const reveal = useRevealTerminal()
  const [showFinished, setShowFinished] = useState(false)
  const { terminal } = planner
  const activeTab =
    terminal?.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal?.tabs[0]
  const chatTitle = useSidebarChatTitle(activeTab)
  const name = terminal
    ? sidebarTerminalDisplayName(terminal, chatTitle)
    : (planner.label ??
      (planner.plannerId ? t('agentsPanel.plannerClosed') : t('agentsPanel.noPlanner')))
  const canReveal = terminal !== null && projectId !== null
  const total = planner.active.length + planner.finished.length

  return (
    <div className={styles.planner}>
      <button
        type="button"
        className={styles.plannerHeader}
        disabled={!canReveal}
        onClick={() => canReveal && reveal(projectId, terminal.id)}
        title={
          canReveal
            ? t('orchestrator.plannerNodeTitle')
            : planner.plannerId
              ? t('orchestrator.plannerGone')
              : undefined
        }
      >
        <AgentGlyph agent={planner.agent} theme={theme} size={13} className={styles.glyph} />
        <span className={styles.plannerName}>{name}</span>
        <span className={styles.plannerCount}>{total}</span>
      </button>
      <div className={styles.plannerJobs}>
        {planner.active.map((job) => (
          <AgentJobRow key={job.id} job={job} theme={theme} />
        ))}
        {planner.finished.length > 0 ? (
          <button
            type="button"
            className={styles.finishedToggle}
            onClick={() => setShowFinished((value) => !value)}
            aria-expanded={showFinished}
          >
            <ChevronRight size={11} className={styles.chevron} data-open={showFinished} />
            {t('agentsPanel.finished', { count: planner.finished.length })}
          </button>
        ) : null}
        {showFinished
          ? planner.finished.map((job) => <AgentJobRow key={job.id} job={job} theme={theme} />)
          : null}
      </div>
    </div>
  )
}

function AgentJobRow({ job, theme }: { job: OrchestratorJob; theme: Theme }) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const [acting, setActing] = useState(false)
  const live = LIVE_STATUSES.has(job.status)
  const elapsed = formatElapsed(job.seconds)
  const details = job.native
    ? [t('agentsPanel.subagent')]
    : [job.model, job.effort, job.role].filter((value): value is string => Boolean(value))
  const cost = job.costUsd !== null ? fmtUsd(job.costUsd) : null
  const ask = job.native ? null : job.pendingApproval

  const cancel = async () => {
    setActing(true)
    try {
      await orchestratorCancelJob(job.id)
    } catch {
      pushToast({ title: t('orchestrator.stopFailed'), body: '' })
    } finally {
      setActing(false)
    }
  }

  const answer = (decision: OrchestratorDecision) => async () => {
    setActing(true)
    try {
      await orchestratorAnswer(job.id, decision)
    } catch {
      pushToast({ title: t('orchestrator.answerFailed'), body: '' })
    } finally {
      setActing(false)
    }
  }

  return (
    <article className={styles.job} data-status={job.status}>
      <span className={styles.statusSlot}>
        {job.status === 'running' ? (
          <DotmCircular2
            size={12}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={t('orchestrator.status.running')}
          />
        ) : (
          <span className={styles.dot} aria-hidden />
        )}
      </span>
      <AgentGlyph
        agent={job.agent}
        theme={theme}
        size={14}
        title={job.agent}
        className={styles.glyph}
      />
      <div className={styles.jobBody}>
        <div className={styles.jobTop}>
          <span className={styles.jobTitle} title={job.spec}>
            {jobTitle(job)}
          </span>
          {elapsed && <span className={styles.elapsed}>{elapsed}</span>}
        </div>
        <div className={styles.jobMeta}>
          {details.length > 0 ? (
            <span className={styles.details} title={details.join(' · ')}>
              {details.join(' · ')}
            </span>
          ) : null}
          {job.status !== 'running' ? (
            <span className={styles.statusLabel}>{t(`orchestrator.status.${job.status}`)}</span>
          ) : null}
          {cost && (
            <span className={styles.cost} title={t('orchestrator.costTitle')}>
              {cost}
            </span>
          )}
        </div>
        {ask ? (
          <div className={styles.ask}>
            <span className={styles.askWhat}>
              {t(
                ask.kind === 'fileChange'
                  ? 'orchestrator.askFileChange'
                  : 'orchestrator.askCommand',
              )}
            </span>
            {ask.command ? (
              <code className={styles.askCommand} title={ask.command}>
                {ask.command}
              </code>
            ) : null}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.answerButton}
                data-decision="accept"
                onClick={answer('accept')}
                disabled={acting}
                title={t('orchestrator.answerAcceptTitle')}
              >
                <Check size={11} />
                {t('orchestrator.answerAccept')}
              </button>
              <button
                type="button"
                className={styles.answerButton}
                onClick={answer('decline')}
                disabled={acting}
                title={t('orchestrator.answerDeclineTitle')}
              >
                <X size={11} />
                {t('orchestrator.answerDecline')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {live && !job.native ? (
        <button
          type="button"
          className={styles.iconAction}
          onClick={cancel}
          disabled={acting}
          title={t('orchestrator.menuStop')}
          aria-label={t('orchestrator.menuStop')}
        >
          <Square size={11} />
        </button>
      ) : null}
    </article>
  )
}

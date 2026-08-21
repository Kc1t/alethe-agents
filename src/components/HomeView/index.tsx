import {
  ArrowRight,
  Bell,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Flame,
  FolderOpen,
  FolderPlus,
  Github,
  Layers,
  PackageOpen,
  Send,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { getCachedActivity } from '../../lib/activityCache'
import { pickDirectory } from '../../lib/dialog'
import { formatHomeDate, formatRelativeTimestamp, getGreeting } from '../../lib/greeting'
import { useT, type TFunction } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { getFirstName, getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { openInBrowser } from '../../lib/tauri'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { UNRESTRICTED_FLAG, type AgentType, type Project } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import { AsciiEffect } from '../ui/ascii-effect'
import { Avatar } from '../ui/Avatar'
import { EmptyState } from '../EmptyState'
import homeBackground from '../../assets/home-bg-right.png'
import { computeStreak } from './ActivityGraph'
import { NowPlayingWidget } from './NowPlayingWidget'
import { UsageStrip } from './UsageStrip'
import { ActivityGraph } from './ActivityGraph'
import { TimeAnalytics } from './TimeAnalytics'
import styles from './HomeView.module.css'

const RECENT_PROJECTS_LIMIT = 6
const NOTIFICATIONS_LIMIT = 5
const REPOSITORY_URL = 'https://github.com/Kc1t/alethe-agents'
const ISSUES_URL = `${REPOSITORY_URL}/issues`
const RELEASES_URL = `${REPOSITORY_URL}/releases`
const QUICK_AGENTS: Array<{ type: AgentType; label: string }> = [
  { type: 'claude', label: 'Claude' },
  { type: 'codex', label: 'Codex' },
  { type: 'copilot', label: 'GitHub Copilot' },
  { type: 'antigravity', label: 'Antigravity' },
  { type: 'opencode', label: 'OpenCode' },
]

function compactWorkspacePath(path: string): string {
  const homeCollapsed = path.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, '~')
  const parts = homeCollapsed.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 4) return homeCollapsed
  const separator = homeCollapsed.includes('\\') ? '\\' : '/'
  return `${homeCollapsed.startsWith('~') ? `~${separator}` : ''}…${separator}${parts.slice(-3).join(separator)}`
}

const NOTIF_AGENT_CLASS: Record<AgentType, string> = {
  claude: styles.notifClaude,
  codex: styles.notifCodex,
  copilot: styles.notifCodex,
  antigravity: styles.notifAntigravity,
  shell: styles.notifShell,
  opencode: styles.notifOpencode,
  freebuff: styles.notifFreebuff,
  mimo: styles.notifMimo,
}

export function HomeView() {
  const t = useT()
  const {
    language,
    preferences,
    projects,
    recentProjectIds,
    containers,
    openContainerWithAllPanes,
    setActiveProjectOnly,
    createAgentTerminal,
  } = useProjectsStore(
    useShallow((s) => ({
      language: s.preferences.language,
      preferences: s.preferences,
      projects: s.projects,
      recentProjectIds: s.workspace.recentProjectIds,
      containers: s.workspace.containers,
      openContainerWithAllPanes: s.openContainerWithAllPanes,
      setActiveProjectOnly: s.setActiveProjectOnly,
      createAgentTerminal: s.createAgentTerminal,
    }))
  )

  const {
    openModal,
    setActiveView,
    setActiveTerminal,
    requestPaneFocus,
    notifications,
    clearNotifications,
  } = useUiStore(
    useShallow((s) => ({
      openModal: s.openModal_,
      setActiveView: s.setActiveView,
      setActiveTerminal: s.setActiveTerminal,
      requestPaneFocus: s.requestPaneFocus,
      notifications: s.notifications,
      clearNotifications: s.clearNotifications,
    }))
  )

                                                                                   
  const lastUsedByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of containers) {
      if (c.lastUsedAt) map.set(c.projectId, c.lastUsedAt)
    }
    for (const p of projects) {
      const fromTerminals = p.terminals.reduce((max, t) => Math.max(max, t.lastUsedAt ?? 0), 0)
      const prev = map.get(p.id) ?? 0
      if (fromTerminals > prev) map.set(p.id, fromTerminals)
    }
    return map
  }, [containers, projects])

  const recentProjects = useMemo<Project[]>(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    const ordered: Project[] = []
    const seen = new Set<string>()
    for (const id of recentProjectIds) {
      const p = byId.get(id)
      if (p && !seen.has(id)) {
        ordered.push(p)
        seen.add(id)
      }
    }
    // completa com os demais projetos (mais recentes por uso) se faltar
    if (ordered.length < RECENT_PROJECTS_LIMIT) {
      const rest = projects
        .filter((p) => !seen.has(p.id))
        .sort((a, b) => (lastUsedByProject.get(b.id) ?? 0) - (lastUsedByProject.get(a.id) ?? 0))
      ordered.push(...rest)
    }
    return ordered.slice(0, RECENT_PROJECTS_LIMIT)
  }, [projects, recentProjectIds, lastUsedByProject])

  const [now, setNow] = useState(() => new Date())
  const [activityStreak, setActivityStreak] = useState<number | null>(null)
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadStreak = async () => {
      try {
        const days = await getCachedActivity(91)
        if (!cancelled) setActivityStreak(computeStreak(days))
      } catch {
        if (!cancelled) setActivityStreak(0)
      }
    }
    void loadStreak()
    return () => {
      cancelled = true
    }
  }, [])

  const greeting = useMemo(() => getGreeting(now, language), [now, language])
  const dateStr = useMemo(() => formatHomeDate(now, language), [now, language])
  const displayName = preferences.displayName
  const firstName = getFirstName(displayName)
  const firstNameLower = firstName.toLowerCase()
  const avatarUrl = getProfileImageUrl(preferences)
  const initial = getProfileInitial(displayName)
  const quickAgents = QUICK_AGENTS.filter((agent) => preferences.enabledAgents[agent.type])
  const fallbackQuickTarget = recentProjects[0] ?? projects[0] ?? null
  const [quickProjectId, setQuickProjectId] = useState(() => fallbackQuickTarget?.id ?? '')
  const quickTarget =
    projects.find((project) => project.id === quickProjectId) ?? fallbackQuickTarget
  const [quickAgentRaw, setQuickAgent] = useState<AgentType>('claude')
  const quickAgentMenuRef = useRef<HTMLDetailsElement>(null)
  const quickModeMenuRef = useRef<HTMLDetailsElement>(null)
  const [quickUnrestricted, setQuickUnrestricted] = useState(false)
  const quickPromptRef = useRef<HTMLInputElement>(null)
  const [quickCwd, setQuickCwd] = useState('')
                                                                                
                                                                           
  const quickAgent = quickAgents.some((agent) => agent.type === quickAgentRaw)
    ? quickAgentRaw
    : (quickAgents[0]?.type ?? 'claude')
  const quickAgentLabel =
    QUICK_AGENTS.find((agent) => agent.type === quickAgent)?.label ?? quickAgent

  useEffect(() => {
    if (quickTarget && quickTarget.id !== quickProjectId) setQuickProjectId(quickTarget.id)
  }, [quickProjectId, quickTarget])

  useEffect(() => {
    if (!quickCwd && quickTarget) setQuickCwd(getProjectDefaultCwd(quickTarget, projects))
  }, [projects, quickCwd, quickTarget])

  const browseQuickFolder = async () => {
    const folder = await pickDirectory({ defaultPath: quickCwd || undefined })
    if (folder) setQuickCwd(folder)
  }

  const submitQuickPrompt = async (event: React.FormEvent) => {
    event.preventDefault()
    const prompt = quickPromptRef.current?.value.trim() ?? ''
    if (!quickTarget || !prompt) return
    const cwd = quickCwd.trim() || getProjectDefaultCwd(quickTarget, projects)
    const flag = quickUnrestricted ? UNRESTRICTED_FLAG[quickAgent] : null
    const label = QUICK_AGENTS.find((agent) => agent.type === quickAgent)?.label ?? quickAgent
    const terminal = await createAgentTerminal(quickTarget.id, {
      name: label,
      cwd,
      firstTab: {
        type: quickAgent,
        cwd,
        extraArgs: flag ? [flag] : undefined,
        initialInput: prompt,
      },
    })
    setActiveProjectOnly(quickTarget.id)
    useProjectsStore.getState().focusWorkspaceTerminal(quickTarget.id, terminal.id)
    setActiveTerminal(quickTarget.id, terminal.id)
    requestPaneFocus(terminal.id)
    if (quickPromptRef.current) quickPromptRef.current.value = ''
    setActiveView('workspace')
  }

  const handleNewTerminal = () => {
    const target = recentProjects[0] ?? projects[0]
    if (target) {
      openModal('newTerminal', { projectId: target.id })
    } else {
      openModal('newProject')
    }
  }

  const openProject = (project: Project) => {
    setActiveProjectOnly(project.id)
    openContainerWithAllPanes(project.id)
    setActiveView('workspace')
  }

  return (
    <section className={styles.home}>
      <div className={styles.homeBackdrop} aria-hidden="true">
        <AsciiEffect
          imageSrc={homeBackground}
          alt=""
          variant="flow"
          fontSize={8}
          reducedMotion={preferences.motionPreference === 'reduced'}
          brightnessBoost={2.25}
          contrast={1.15}
          threshold={0.02}
          flowSpeed={0.16}
          flowStrength={9}
          mouseRadius={260}
          mouseStrength={16}
          scale={1}
          fit="cover"
          colors={['var(--fg-muted)', 'var(--fg)']}
          backgroundColor="transparent"
        />
      </div>
      <section className={styles.heroStage}>
        <div className={styles.identity}>
          <div className={styles.identityMedia}>
            <div
              className={styles.streakBubble}
              title={
                activityStreak === null ? undefined : t('activity.streak', { n: activityStreak })
              }
              aria-label={
                activityStreak === null ? undefined : t('activity.streak', { n: activityStreak })
              }
            >
              <span className={styles.streakFlame} aria-hidden="true">
                <Flame size={11} />
              </span>
              <strong>{activityStreak ?? '–'}</strong>
            </div>
            <Avatar key={avatarUrl} src={avatarUrl} initial={initial} className={styles.avatar} />
            <div className={styles.homePlayerDock}>
              <NowPlayingWidget enabled />
            </div>
          </div>
          <div className={styles.heroCopy}>
            <h1 className={styles.greeting}>
              {greeting}, {firstNameLower}.
            </h1>
            <div className={styles.date}>{dateStr}</div>
          </div>
        </div>

        <form className={styles.quickLaunch} onSubmit={(e) => void submitQuickPrompt(e)}>
          <div className={styles.quickTerminalBar} aria-hidden="true">
            <span className={`${styles.quickTerminalDot} ${styles.quickTerminalClose}`} />
            <span className={`${styles.quickTerminalDot} ${styles.quickTerminalWait}`} />
            <span className={`${styles.quickTerminalDot} ${styles.quickTerminalReady}`} />
            <span className={styles.quickTerminalTitle}>{t('home.quickTerminalTitle')}</span>
          </div>
          <label className={styles.quickPromptLine}>
            <span aria-hidden="true">›</span>
            <input
              ref={quickPromptRef}
              className={styles.quickPrompt}
              placeholder={t('home.quickPromptPlaceholder')}
              aria-label={t('home.quickPrompt')}
              required
            />
          </label>
          <div className={styles.quickToolbar}>
            <details
              ref={quickAgentMenuRef}
              className={styles.quickAgentMenu}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  event.currentTarget.open = false
              }}
            >
              <summary title={t('home.quickAgent')} aria-label={t('home.quickAgent')}>
                <AgentIcon type={quickAgent} size={15} theme={preferences.uiTheme} />
                <span className={styles.quickControlLabel}>{t('home.quickAgentShort')}:</span>
                <span>{quickAgentLabel}</span>
                <ChevronDown size={10} />
              </summary>
              <div className={styles.quickAgentOptions}>
                {quickAgents.map((agent) => (
                  <button
                    key={agent.type}
                    type="button"
                    className={quickAgent === agent.type ? styles.quickAgentActive : ''}
                    title={agent.label}
                    aria-label={agent.label}
                    onClick={() => {
                      setQuickAgent(agent.type)
                      quickAgentMenuRef.current?.removeAttribute('open')
                    }}
                  >
                    <AgentIcon type={agent.type} size={19} theme={preferences.uiTheme} />
                    <span>{agent.label}</span>
                    {quickAgent === agent.type ? <CheckCircle2 size={13} /> : null}
                  </button>
                ))}
              </div>
            </details>
            <button
              type="button"
              className={styles.quickProject}
              onClick={() => void browseQuickFolder()}
              title={quickCwd || t('term.chooseFolder')}
              aria-label={t('term.chooseFolder')}
            >
              <FolderOpen size={13} />
              <span className={styles.quickControlLabel}>{t('home.quickPath')}:</span>
              <span className={styles.quickPathValue}>
                {compactWorkspacePath(quickCwd || t('home.quickFolderPlaceholder'))}
              </span>
              <ChevronDown size={10} />
            </button>
            <details
              ref={quickModeMenuRef}
              className={styles.quickMode}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  event.currentTarget.open = false
              }}
            >
              <summary aria-label={t('home.quickPermissions')}>
                <span className={styles.quickModeDot} aria-hidden="true" />
                <span className={styles.quickControlLabel}>{t('home.quickMode')}:</span>
                <span>
                  {quickUnrestricted ? t('home.quickUnrestricted') : t('home.quickRestricted')}
                </span>
                <ChevronDown size={10} />
              </summary>
              <div className={`${styles.quickSelectOptions} ${styles.quickModeOptions}`}>
                {(['restricted', 'unrestricted'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={
                      quickUnrestricted === (mode === 'unrestricted')
                        ? styles.quickSelectActive
                        : ''
                    }
                    onClick={() => {
                      setQuickUnrestricted(mode === 'unrestricted')
                      quickModeMenuRef.current?.removeAttribute('open')
                    }}
                  >
                    <span className={styles.quickModeDot} aria-hidden="true" />
                    <span>
                      {mode === 'unrestricted'
                        ? t('home.quickUnrestricted')
                        : t('home.quickRestricted')}
                    </span>
                  </button>
                ))}
              </div>
            </details>
            <button
              type="submit"
              className={styles.quickSend}
              disabled={!quickTarget || quickAgents.length === 0}
              title={t('home.quickSend')}
              aria-label={t('home.quickSend')}
            >
              <Send size={14} />
            </button>
          </div>
        </form>

        <div className={styles.heroFooter}>
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.heroSecondaryAction}
              onClick={handleNewTerminal}
            >
              <TerminalSquare size={14} />
              {t('home.newTerminal')}
            </button>
            <button
              type="button"
              className={styles.heroSecondaryAction}
              onClick={() => openModal('newProject')}
            >
              <FolderPlus size={14} />
              {t('home.newProject')}
            </button>
          </div>
        </div>
      </section>

      <div className={styles.overviewGrid}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            {t('home.recentProjects')}
            {recentProjects.length > 0 ? (
              <>
                <span className={styles.sectionCount}>{recentProjects.length}</span>
                <button
                  type="button"
                  className={styles.sectionAction}
                  onClick={() => setActiveView('workspace')}
                >
                  {t('home.viewAll')}
                </button>
              </>
            ) : null}
          </div>
          {recentProjects.length > 0 ? (
            <div className={styles.projectGrid}>
              {recentProjects.map((project) => (
                <RecentProjectCard
                  key={project.id}
                  project={project}
                  lastUsedAt={lastUsedByProject.get(project.id) ?? 0}
                  now={now.getTime()}
                  onOpen={() => openProject(project)}
                  t={t}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<FolderPlus size={22} />}
              title={t('home.projectsEmptyTitle')}
              description={t('home.projectsEmptyDesc')}
              primaryAction={{
                label: t('home.projectsEmptyAction'),
                onClick: () => openModal('newProject'),
              }}
            />
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>{t('home.startSomething')}</div>
          <div className={styles.actionList}>
            <ActionCard
              icon={<TerminalSquare size={14} />}
              label={t('home.newTerminal')}
              shortcut={formatShortcut('Ctrl+T')}
              onClick={handleNewTerminal}
            />
            <ActionCard
              icon={<FolderPlus size={14} />}
              label={t('home.newProject')}
              shortcut={formatShortcut('Ctrl+Shift+P')}
              onClick={() => openModal('newProject')}
            />
            <ActionCard
              icon={<Layers size={14} />}
              label={t('home.newGroup')}
              shortcut={formatShortcut('Ctrl+Shift+G')}
              onClick={() => openModal('newGroup')}
            />
          </div>
        </section>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>{t('home.usageActivity')}</div>
        <UsageStrip />
      </section>

      <section className={`${styles.section} ${styles.timeAnalyticsSection}`}>
        <ActivityGraph />
      </section>

      <section id="time-analytics" className={`${styles.section} ${styles.timeAnalyticsSection}`}>
        <TimeAnalytics />
      </section>

      <div className={styles.bottomGrid}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            {t('home.notifications')}
            {notifications.length > 0 ? (
              <>
                <span className={styles.sectionCount}>{notifications.length}</span>
                <button
                  type="button"
                  className={styles.sectionAction}
                  onClick={() => clearNotifications()}
                >
                  {t('home.clear')}
                </button>
              </>
            ) : null}
          </div>
          {notifications.length > 0 ? (
            <ul className={styles.notifList}>
              {notifications.slice(0, NOTIFICATIONS_LIMIT).map((n) => (
                <li key={n.id} className={styles.notifItem}>
                  <span
                    className={`${styles.notifIcon} ${
                      n.agent ? NOTIF_AGENT_CLASS[n.agent] : styles.notifNeutral
                    }`}
                  >
                    {n.agent ? (
                      <AgentIcon type={n.agent} size={14} theme={preferences.uiTheme} />
                    ) : (
                      <Bell size={13} />
                    )}
                  </span>
                  <span className={styles.notifBody}>
                    <span className={styles.notifTitle}>{n.title}</span>
                    <span className={styles.notifText}>{n.body}</span>
                  </span>
                  <span className={styles.notifTime}>
                    {formatRelativeTimestamp(n.createdAt, now.getTime(), language)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              compact
              tone="positive"
              icon={<CheckCircle2 size={18} />}
              title={t('home.notificationsEmptyTitle')}
              description={t('home.notificationsEmptyDesc')}
            />
          )}
        </section>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerLinks}>
          <FooterLink
            icon={<Github size={13} />}
            label={t('home.repository')}
            onClick={() => void openInBrowser(REPOSITORY_URL)}
          />
          <FooterLink
            icon={<CircleDot size={13} />}
            label={t('home.issues')}
            onClick={() => void openInBrowser(ISSUES_URL)}
          />
          <FooterLink
            icon={<PackageOpen size={13} />}
            label={t('home.releases')}
            onClick={() => void openInBrowser(RELEASES_URL)}
          />
        </div>
        <div className={styles.footerShortcuts}>
          <FooterShortcut
            keys={formatShortcut('Ctrl+P')}
            label={t('home.searchShortcut')}
            onClick={() => openModal('findJump')}
          />
          <FooterShortcut keys={formatShortcut('Ctrl+K')} label={t('home.commandShortcut')} />
          <FooterShortcut keys="?" label={t('home.helpShortcut')} />
        </div>
      </footer>
    </section>
  )
}

function RecentProjectCard({
  project,
  lastUsedAt,
  now,
  onOpen,
  t,
}: {
  project: Project
  lastUsedAt: number
  now: number
  onOpen: () => void
  t: TFunction
}) {
  const terminalCount = project.terminals.length
  return (
    <button type="button" className={styles.projectCard} onClick={onOpen}>
      <ProjectBadge project={project} />
      <span className={styles.projectInfo}>
        <span className={styles.projectName} title={project.name}>
          {project.name}
        </span>
        <span className={styles.projectMeta}>
          {terminalCount === 1
            ? t('home.terminalsOne', { n: terminalCount })
            : t('home.terminalsMany', { n: terminalCount })}
          {lastUsedAt ? ` · ${formatRelativeTimestamp(lastUsedAt, now)}` : ''}
        </span>
      </span>
      <ArrowRight size={15} className={styles.projectArrow} />
    </button>
  )
}

function ProjectBadge({ project }: { project: Project }) {
  if (project.iconUrl) {
    return <img src={project.iconUrl} alt="" className={styles.projectLogo} draggable={false} />
  }
  const letter = project.name.trim().charAt(0).toUpperCase() || '·'
  return (
    <span
      className={styles.projectLogoFallback}
      style={project.color ? { background: project.color } : undefined}
    >
      {letter}
    </span>
  )
}

function ActionCard({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut: string
  onClick: () => void
}) {
  return (
    <button type="button" className={styles.actionCard} onClick={onClick}>
      <span className={styles.actionIcon}>{icon}</span>
      <span className={styles.actionLabel}>{label}</span>
      <span className={styles.actionSpacer} />
      <kbd className={styles.kbd}>{shortcut}</kbd>
    </button>
  )
}

function FooterShortcut({
  keys,
  label,
  onClick,
}: {
  keys: string
  label: string
  onClick?: () => void
}) {
  return (
    <button type="button" className={styles.footerShortcut} onClick={onClick}>
      <kbd className={styles.kbd}>{keys}</kbd>
      <span>{label}</span>
    </button>
  )
}

function FooterLink({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button type="button" className={styles.footerLink} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

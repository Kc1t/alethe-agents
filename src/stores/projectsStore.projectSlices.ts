/** Group and project actions extracted from the main store. */

import { nanoid } from 'nanoid'

import { restartAgentPty } from '../lib/agentPtyRestart'
import { getLocale, translate } from '../lib/i18n'
import { getActiveSessions, savedConversationIdFor } from '../lib/sessionResume'
import {
  clearTerminalPtyIds,
  collectTerminalPtyIds,
  getProjectRepoRoot,
} from '../lib/terminalFactory'
import { cleanupPtys } from '../lib/terminalLifecycle'
import { killPty, listenPtyData } from '../lib/tauri'
import type { Group, Project, AgentType } from '../lib/types'
import { GROUP_COLORS } from '../lib/types'
import { sanitizeWorkspaceSnapshot } from '../lib/workspaceNavigation'
import type { ProjectsState } from './projectsStore'
import { collectGroupProjectIds } from './projectsStore.migrations'
import type { SliceCtx } from './projectsStore.slices'
import { useUiStore } from './uiStore'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

const migratingWorktreeProjectIds = new Set<string>()

/**
 * Providers cujo `--resume`/`--session <id>` foi CONFIRMADO (testado de
 * verdade, não suposto) funcionar vindo de um cwd diferente de onde a
 * sessão nasceu — relevante só pra migração pra worktree, onde o cwd
 * necessariamente muda. Storage de sessão de todo provider já é global por
 * usuário (não por pasta — Claude em `~/.claude/`, Codex em `~/.codex/`,
 * OpenCode em `~/.local/share/opencode/opencode.db`), então em teoria os
 * dados sempre existem; a dúvida real é só se o CLI aceita retomar por ID
 * cru vindo de outro diretório.
 *
 * `opencode` testado nesta sessão: `opencode --session <id>` a partir de um
 * cwd diferente do original TRAVA indefinidamente (sem erro, sem saída —
 * matado manualmente após 150s) — não é um "resume falhou", é um hang.
 * `false` de propósito até haver confirmação equivalente. Codex/Claude
 * ainda não testados (CLI indisponível na máquina de dev) — tratados com a
 * mesma cautela até serem verificados.
 */
const CROSS_CWD_RESUME_OK: Partial<Record<AgentType, boolean>> = {
  opencode: false,
}

/** Migração tentando um resume cross-cwd pode travar (hang, não erro —
 *  confirmado com OpenCode) em vez de falhar rápido. Corre entre "chegou
 *  algum byte de saída" e um teto de tempo; sem nenhuma saída no prazo,
 *  mata o processo travado e tenta de novo como sessão nova, sem propagar
 *  a falha pro restante do loop de migração. */
const RESUME_HANG_GUARD_MS = 8_000

async function restartAgentPtyWithHangGuard(
  opts: Parameters<typeof restartAgentPty>[0],
): Promise<ReturnType<typeof restartAgentPty>> {
  if (!opts.resumeId) return restartAgentPty(opts)

  const result = await restartAgentPty(opts)
  const gotOutput = await new Promise<boolean>((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, RESUME_HANG_GUARD_MS)
    void listenPtyData(result.id, () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(true)
    }).catch(() => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(false)
    })
  })
  if (gotOutput) return result

  console.warn(
    `[projectsStore] resume cross-cwd de ${opts.agent} sem nenhuma saída em ${RESUME_HANG_GUARD_MS}ms (provável hang) — matando e reabrindo como sessão nova`,
  )
  await killPty(result.id).catch(() => {})
  return restartAgentPty({ ...opts, resumeId: undefined })
}

type GroupsSlice = Pick<
  ProjectsState,
  | 'createGroup'
  | 'moveGroupToParent'
  | 'renameGroup'
  | 'setGroupColor'
  | 'setGroupIconUrl'
  | 'toggleGroupCollapsed'
  | 'archiveGroup'
  | 'unarchiveGroup'
  | 'suspendGroup'
  | 'resumeGroup'
  | 'deleteGroup'
  | 'reorderGroups'
  | 'moveProjectToGroup'
  | 'reorderProjectInGroup'
  | 'reorderUngrouped'
>

export function createGroupsSlice({ update }: SliceCtx): GroupsSlice {
  return {
    createGroup: (name, color, parentGroupId = null) => {
      const group: Group = {
        id: nanoid(),
        name,
        color: color ?? GROUP_COLORS[0],
        collapsed: false,
        projectIds: [],
        parentGroupId,
        createdAt: Date.now(),
      }
      update((state) => ({ groups: [...state.groups, group] }))
      return group
    },

    moveGroupToParent: (groupId, parentGroupId, atIndex) =>
      update((state) => {
        if (groupId === parentGroupId) return
        const source = state.groups.find((group) => group.id === groupId)
        if (!source) return
        if (source.parentGroupId === parentGroupId && atIndex === undefined) return

        // Prevent cycles: a group cannot become its descendant's child.
        if (parentGroupId !== null) {
          let cur: string | null = parentGroupId
          while (cur !== null) {
            if (cur === groupId) return
            const next: Group | undefined = state.groups.find((g) => g.id === cur)
            cur = next?.parentGroupId ?? null
          }
        }

        const remaining = state.groups.filter((group) => group.id !== groupId)
        const siblings = remaining.filter((group) => group.parentGroupId === parentGroupId)
        const siblingIndex = Math.max(0, Math.min(atIndex ?? siblings.length, siblings.length))
        const nextSibling = siblings[siblingIndex]
        const previousSibling = siblings[siblingIndex - 1]
        const globalIndex = nextSibling
          ? remaining.findIndex((group) => group.id === nextSibling.id)
          : previousSibling
            ? remaining.findIndex((group) => group.id === previousSibling.id) + 1
            : remaining.length

        const nextGroups = [...remaining]
        nextGroups.splice(globalIndex, 0, { ...source, parentGroupId })
        return {
          groups: nextGroups,
        }
      }),

    renameGroup: (id, name) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      })),

    setGroupColor: (id, color) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, color } : g)),
      })),

    setGroupIconUrl: (id, iconUrl) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, iconUrl } : g)),
      })),

    toggleGroupCollapsed: (id) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
      })),

    archiveGroup: (id) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, archived: true } : g)),
      })),

    unarchiveGroup: (id) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, archived: false } : g)),
      })),

    suspendGroup: (groupId) =>
      update((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group || group.suspended) return

        const allProjectIds = collectGroupProjectIds(groupId, state.groups)
        cleanupPtys(
          collectTerminalPtyIds(
            state.projects.filter((p) => allProjectIds.has(p.id)).flatMap((p) => p.terminals),
          ),
        )

        // Disable all terminals in the group's projects.
        const projects = state.projects.map((p) => {
          if (!allProjectIds.has(p.id)) return p
          return {
            ...p,
            terminals: p.terminals.map((t) => ({ ...clearTerminalPtyIds(t), disabled: true })),
          }
        })

        // Close those project containers.
        const containers = state.workspace.containers.filter((c) => !allProjectIds.has(c.projectId))

        // Mark the group and descendants as suspended.
        const groups = state.groups.map((g) => {
          if (g.id === groupId) return { ...g, suspended: true }
          return g
        })

        return { groups, projects, workspace: { ...state.workspace, containers } }
      }),

    resumeGroup: (groupId) =>
      update((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group || !group.suspended) return

        const allProjectIds = collectGroupProjectIds(groupId, state.groups)

        // Re-enable all terminals.
        const projects = state.projects.map((p) => {
          if (!allProjectIds.has(p.id)) return p
          return {
            ...p,
            terminals: p.terminals.map((t) => ({ ...t, disabled: false })),
          }
        })

        const groups = state.groups.map((g) => {
          if (g.id === groupId) return { ...g, suspended: false }
          return g
        })

        return { groups, projects }
      }),

    deleteGroup: (id, mode) =>
      update((state) => {
        const group = state.groups.find((g) => g.id === id)
        if (!group) return
        if (mode === 'cascade') {
          // Collect all descendants with a breadth-first traversal.
          const groupQueue = [id]
          const groupsToRemove = new Set<string>()
          while (groupQueue.length > 0) {
            const cur = groupQueue.shift()!
            if (groupsToRemove.has(cur)) continue
            groupsToRemove.add(cur)
            for (const g of state.groups) {
              if (g.parentGroupId === cur) groupQueue.push(g.id)
            }
          }
          const projectsToRemove = new Set<string>()
          for (const p of state.projects) {
            if (p.groupId && groupsToRemove.has(p.groupId)) projectsToRemove.add(p.id)
          }
          cleanupPtys(
            collectTerminalPtyIds(
              state.projects.filter((p) => projectsToRemove.has(p.id)).flatMap((p) => p.terminals),
            ),
          )
          const remainingProjects = state.projects.filter((p) => !projectsToRemove.has(p.id))
          const tabs = state.workspace.tabs
            .filter(
              (tab) =>
                !(tab.kind === 'group' && groupsToRemove.has(tab.sourceId ?? tab.id)) &&
                !(tab.kind === 'project' && projectsToRemove.has(tab.sourceId ?? tab.id)) &&
                !(tab.kind === 'terminal' && projectsToRemove.has(tab.sourceProjectId ?? '')),
            )
            .map((tab) => ({
              ...tab,
              snapshot: sanitizeWorkspaceSnapshot(tab.snapshot, remainingProjects),
            }))
          const tabIds = new Set(tabs.map((tab) => tab.id))
          const activeTabId = tabIds.has(state.workspace.activeTabId ?? '')
            ? state.workspace.activeTabId
            : (tabs[0]?.id ?? null)
          const history = state.workspace.history
            .filter((entry) => tabIds.has(entry.tabId))
            .map((entry) => {
              const tab = tabs.find((tab) => tab.id === entry.tabId)
              return {
                ...entry,
                snapshot: tab
                  ? sanitizeWorkspaceSnapshot(entry.snapshot, remainingProjects)
                  : entry.snapshot,
              }
            })
          return {
            groups: state.groups.filter((g) => !groupsToRemove.has(g.id)),
            projects: remainingProjects,
            workspace: {
              ...state.workspace,
              containers: state.workspace.containers.filter(
                (c) => !projectsToRemove.has(c.projectId),
              ),
              recentProjectIds: (state.workspace.recentProjectIds ?? []).filter(
                (pid) => !projectsToRemove.has(pid),
              ),
              recentTabs: (state.workspace.recentTabs ?? []).filter((tab) =>
                tab.kind === 'group' ? !groupsToRemove.has(tab.id) : !projectsToRemove.has(tab.id),
              ),
              tabs,
              activeTabId,
              history,
              historyIndex: Math.min(state.workspace.historyIndex, history.length - 1),
            },
            activeProjectId: projectsToRemove.has(state.activeProjectId ?? '')
              ? (remainingProjects[0]?.id ?? null)
              : state.activeProjectId,
          }
        }
        // Unassign projects and move direct subgroups to the root.
        return {
          groups: state.groups
            .filter((g) => g.id !== id)
            .map((g) => (g.parentGroupId === id ? { ...g, parentGroupId: null } : g)),
          projects: state.projects.map((p) => (p.groupId === id ? { ...p, groupId: null } : p)),
          ungroupedOrder: [
            ...state.ungroupedOrder,
            ...group.projectIds.filter((pid) => !state.ungroupedOrder.includes(pid)),
          ],
          workspace: {
            ...state.workspace,
            recentTabs: (state.workspace.recentTabs ?? []).filter(
              (tab) => !(tab.kind === 'group' && tab.id === id),
            ),
          },
        }
      }),

    reorderGroups: (fromIndex, toIndex) =>
      update((state) => {
        const next = [...state.groups]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { groups: next }
      }),

    moveProjectToGroup: (projectId, groupId, atIndex) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project || project.groupId === groupId) return
        const oldGroupId = project.groupId
        // Remove from the old group or ungrouped list.
        let groups = state.groups.map((g) => {
          if (g.id === oldGroupId) {
            return { ...g, projectIds: g.projectIds.filter((id) => id !== projectId) }
          }
          return g
        })
        let ungroupedOrder = state.ungroupedOrder
        if (oldGroupId === null) {
          ungroupedOrder = ungroupedOrder.filter((id) => id !== projectId)
        }
        // Add to the destination.
        if (groupId === null) {
          const next = [...ungroupedOrder]
          if (atIndex === undefined || atIndex < 0 || atIndex > next.length) {
            next.push(projectId)
          } else {
            next.splice(atIndex, 0, projectId)
          }
          ungroupedOrder = next
        } else {
          groups = groups.map((g) => {
            if (g.id !== groupId) return g
            const next = [...g.projectIds]
            if (atIndex === undefined || atIndex < 0 || atIndex > next.length) {
              next.push(projectId)
            } else {
              next.splice(atIndex, 0, projectId)
            }
            return { ...g, projectIds: next }
          })
        }
        return {
          groups,
          ungroupedOrder,
          projects: state.projects.map((p) => (p.id === projectId ? { ...p, groupId } : p)),
        }
      }),

    reorderProjectInGroup: (projectId, fromIndex, toIndex) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project || project.groupId === null) return
        return {
          groups: state.groups.map((g) => {
            if (g.id !== project.groupId) return g
            const next = [...g.projectIds]
            const [moved] = next.splice(fromIndex, 1)
            next.splice(toIndex, 0, moved)
            return { ...g, projectIds: next }
          }),
        }
      }),

    reorderUngrouped: (_projectId, fromIndex, toIndex) =>
      update((state) => {
        const next = [...state.ungroupedOrder]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { ungroupedOrder: next }
      }),
  }
}

type ProjectsSlice = Pick<
  ProjectsState,
  | 'createProject'
  | 'importProjectFromFile'
  | 'renameProject'
  | 'archiveProject'
  | 'unarchiveProject'
  | 'setProjectColor'
  | 'setProjectIconUrl'
  | 'addMarkdownComment'
  | 'removeMarkdownComment'
  | 'setWorktreeMode'
  | 'setValidationCommands'
  | 'setHealthCheckCommand'
  | 'setHealthCheckPath'
  | 'setConflictAgentProvider'
  | 'setConflictAgentModel'
  | 'setReviewAgentProvider'
  | 'setReviewAgentModel'
  | 'setAutoWorktree'
  | 'setMergePostAction'
  | 'relocateMergeAgentTerminal'
  | 'migrateProjectTerminalsToWorktrees'
  | 'addOrphanWorktree'
  | 'removeOrphanWorktree'
  | 'setCleaningOrphans'
  | 'cleanupOrphanWorktrees'
  | 'deleteProject'
>

export function createProjectsSlice({ set, get, update, updateProject }: SliceCtx): ProjectsSlice {
  return {
    createProject: ({
      name,
      mode = 'standard',
      color,
      iconUrl,
      groupId = null,
      defaultCwd,
      githubUrl,
      firstBootPending,
    }) => {
      const project: Project = {
        id: nanoid(),
        name,
        mode,
        color,
        iconUrl,
        groupId,
        ...(defaultCwd?.trim() ? { defaultCwd: defaultCwd.trim() } : {}),
        githubUrl,
        firstBootPending,
        terminals: [],
        layoutMode: 'auto',
        collapsed: false,
        createdAt: Date.now(),
      }
      update((state) => {
        const groups =
          groupId === null
            ? state.groups
            : state.groups.map((g) =>
                g.id === groupId ? { ...g, projectIds: [...g.projectIds, project.id] } : g,
              )
        const ungroupedOrder =
          groupId === null ? [...state.ungroupedOrder, project.id] : state.ungroupedOrder
        return {
          projects: [...state.projects, project],
          groups,
          ungroupedOrder,
          activeProjectId: state.activeProjectId ?? project.id,
        }
      })
      return project
    },

    importProjectFromFile: (data, groupId = null) => {
      const project: Project = {
        ...data,
        id: nanoid(),
        groupId,
        archived: false,
        createdAt: Date.now(),
        // Nunca existe processo vivo pra reaproveitar num projeto recém-
        // importado — zera ptyId de toda tab, mas preserva sessionId (tenta
        // resumir de propósito no próximo spawn, mesma lógica do item de
        // migração de worktree).
        terminals: (data.terminals ?? []).map((terminal) => ({
          ...terminal,
          tabs: terminal.tabs.map((tab) => ({ ...tab, ptyId: null })),
        })),
      }
      update((state) => {
        const groups =
          groupId === null
            ? state.groups
            : state.groups.map((g) =>
                g.id === groupId ? { ...g, projectIds: [...g.projectIds, project.id] } : g,
              )
        const ungroupedOrder =
          groupId === null ? [...state.ungroupedOrder, project.id] : state.ungroupedOrder
        return { projects: [...state.projects, project], groups, ungroupedOrder }
      })
      return project
    },

    renameProject: (id, name) => updateProject(id, (p) => ({ ...p, name })),

    archiveProject: (id) => updateProject(id, (p) => ({ ...p, archived: true })),

    unarchiveProject: (id) => updateProject(id, (p) => ({ ...p, archived: false })),

    setProjectColor: (id, color) => updateProject(id, (p) => ({ ...p, color })),

    setProjectIconUrl: (id, iconUrl) => updateProject(id, (p) => ({ ...p, iconUrl })),

    addMarkdownComment: (projectId, comment) =>
      updateProject(projectId, (p) => ({
        ...p,
        markdownComments: [
          ...(p.markdownComments ?? []),
          { ...comment, id: nanoid(), createdAt: Date.now() },
        ],
      })),

    removeMarkdownComment: (projectId, commentId) =>
      updateProject(projectId, (p) => ({
        ...p,
        markdownComments: (p.markdownComments ?? []).filter((comment) => comment.id !== commentId),
      })),

    setWorktreeMode: (id, worktreeMode) => updateProject(id, (p) => ({ ...p, worktreeMode })),

    setValidationCommands: (id, validationCommands) =>
      updateProject(id, (p) => ({ ...p, validationCommands })),

    setHealthCheckCommand: (id, healthCheckCommand) =>
      updateProject(id, (p) => ({ ...p, healthCheckCommand })),

    setHealthCheckPath: (id, healthCheckPath) =>
      updateProject(id, (p) => ({ ...p, healthCheckPath })),

    setConflictAgentProvider: (id, conflictAgentProvider) =>
      updateProject(id, (p) => ({ ...p, conflictAgentProvider })),

    setConflictAgentModel: (id, conflictAgentModel) =>
      updateProject(id, (p) => ({ ...p, conflictAgentModel })),

    setReviewAgentProvider: (id, reviewAgentProvider) =>
      updateProject(id, (p) => ({ ...p, reviewAgentProvider })),

    setReviewAgentModel: (id, reviewAgentModel) =>
      updateProject(id, (p) => ({ ...p, reviewAgentModel })),

    setAutoWorktree: (id, autoWorktree) => updateProject(id, (p) => ({ ...p, autoWorktree })),

    setMergePostAction: (id, mergePostAction) =>
      updateProject(id, (p) => ({ ...p, mergePostAction })),

    relocateMergeAgentTerminal: async (projectId, terminalId, opts) => {
      const project = get().projects.find((p) => p.id === projectId)
      const terminal = project?.terminals.find((t) => t.id === terminalId)
      if (!project || !terminal) return { ok: false, error: 'terminal_not_found' }

      const repo = getProjectRepoRoot(project)
      if (!repo) return { ok: false, error: 'no_repo' }

      try {
        const { worktreeProvision } = await import('../lib/tauri')
        const agentId = `merge-${nanoid(6)}`
        const info = await worktreeProvision(repo, agentId, project.worktreeMode ?? 'gitWorktree')

        updateProject(projectId, (p) => ({
          ...p,
          terminals: p.terminals.map((t) => {
            if (t.id !== terminalId) return t
            return {
              ...t,
              cwd: info.path,
              worktreeAgentId: agentId,
              tabs: t.tabs.map((tab) => ({ ...tab, cwd: info.path, sessionId: undefined })),
            }
          }),
        }))

        for (const tab of terminal.tabs) {
          if (!tab.ptyId) continue
          const activeSessions = getActiveSessions()
          const savedSession = activeSessions[tab.id] ?? activeSessions[tab.ptyId] ?? null
          const preservedResumeId =
            tab.sessionId ?? savedConversationIdFor(savedSession, tab.type, terminal.cwd)
          const effectiveResumeId =
            opts.keepSession && CROSS_CWD_RESUME_OK[tab.type] ? preservedResumeId : undefined
          try {
            await restartAgentPtyWithHangGuard({
              ptyId: tab.ptyId,
              sessionPersistenceKey: tab.id,
              agent: tab.type,
              cwd: info.path,
              runtimeProfile: tab.runtimeProfile,
              extraArgs: tab.extraArgs ?? [],
              resumeId: effectiveResumeId,
              onSessionId: (id) =>
                updateProject(projectId, (p) => ({
                  ...p,
                  terminals: p.terminals.map((t) =>
                    t.id !== terminalId
                      ? t
                      : {
                          ...t,
                          tabs: t.tabs.map((tb) =>
                            tb.id === tab.id ? { ...tb, sessionId: id } : tb,
                          ),
                        },
                  ),
                })),
            })
            window.dispatchEvent(
              new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId: tab.ptyId } }),
            )
          } catch (restartErr) {
            console.warn(
              '[projectsStore] failed restarting merge terminal in the new worktree:',
              restartErr,
            )
          }
        }

        return { ok: true }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },

    migrateProjectTerminalsToWorktrees: async (projectId, opts) => {
      if (migratingWorktreeProjectIds.has(projectId)) return { status: 'aborted' }
      const project = get().projects.find((p) => p.id === projectId)
      if (!project) return { status: 'aborted' }
      const repo = getProjectRepoRoot(project)
      if (!repo) {
        useUiStore.getState().pushToast({
          title: t('multiAgent.migrateNoRepoTitle'),
          body: t('multiAgent.migrateNoRepoBody'),
        })
        return { status: 'aborted' }
      }

      migratingWorktreeProjectIds.add(projectId)
      try {
        const { worktreeProvision, gitStatus } = await import('../lib/tauri')

        // Probed up front so a non-repo is reported as such, instead of the raw
        // not_a_git_repository error leaking into the final toast.
        let status: Awaited<ReturnType<typeof gitStatus>> | null = null
        try {
          status = await gitStatus(repo)
        } catch {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateNoRepoTitle'),
            body: t('multiAgent.migrateNoRepoBody'),
          })
          return { status: 'aborted' }
        }
        // Uncommitted work does NOT block the migration: every worktree is
        // created from HEAD (or a --local clone), so pending changes simply
        // stay in the main repository, untouched. The caller confirms once and
        // calls back with `allowDirty` — see `migrateDirtyConfirm`.
        const pending =
          status.staged.length + status.changes.length + status.untracked.length
        if (pending > 0 && !opts?.allowDirty) {
          return { status: 'dirty', pending }
        }

        const targets = project.terminals.filter(
          (terminal) =>
            !terminal.worktreeAgentId && terminal.kind !== 'web' && terminal.kind !== 'file',
        )
        const succeeded: string[] = []
        const failed: { name: string; error: string }[] = []

        for (const terminal of targets) {
          try {
            const agentId = `${terminal.name.toLowerCase().slice(0, 8)}-${nanoid(6)}`.replace(
              /[^A-Za-z0-9_-]/g,
              'x',
            )
            const info = await worktreeProvision(
              repo,
              agentId,
              project.worktreeMode ?? 'gitWorktree',
            )

            // Update cwd/worktreeAgentId/sessionId (cleared — the new session
            // has no known ID yet) BEFORE restarting the tabs. Order matters:
            // `onSessionId` below writes the new ID (synchronously for Claude,
            // asynchronously for the other 3 via
            // `watchAndPersistDiscoveredSession`) always AFTER this clear,
            // never before — without that guaranteed order a synchronous write
            // could be overwritten back by a late "clear".
            updateProject(projectId, (p) => ({
              ...p,
              terminals: p.terminals.map((t) => {
                if (t.id !== terminal.id) return t
                return {
                  ...t,
                  cwd: info.path,
                  worktreeAgentId: agentId,
                  tabs: t.tabs.map((tab) => ({ ...tab, cwd: info.path, sessionId: undefined })),
                }
              }),
            }))

            // Each tab's pane is already mounted (`key={tab.id}`, stable) and
            // the XTermView mount effect only reacts to `sessionPersistenceKey`/
            // `retryKey` — changing `cwd` in the store alone makes the pane
            // notice nothing, it keeps showing the old session in the old folder
            // (a real bug, seen directly: the toast said "done" but the terminal
            // never moved). Restart EVERY tab with a live PTY ON THE SAME ptyId
            // (the same mechanism as the context menu's "Restart", via
            // `restartAgentPty`) — the pane already listens on that channel, so
            // it does not need to remount. Each provider's session storage is
            // global per user, not per folder — the old conversation MAY really
            // exist in the new worktree; only reuse it for providers with
            // confirmed cross-cwd resume (`CROSS_CWD_RESUME_OK`, empty today —
            // none proven safe yet), guarded against hangs
            // (`restartAgentPtyWithHangGuard`). Tabs without a PTY (never
            // opened) only need the updated cwd — their first mount already
            // starts in the right place.
            for (const tab of terminal.tabs) {
              if (!tab.ptyId) continue
              const activeSessions = getActiveSessions()
              const savedSession = activeSessions[tab.id] ?? activeSessions[tab.ptyId] ?? null
              const preservedResumeId =
                tab.sessionId ?? savedConversationIdFor(savedSession, tab.type, terminal.cwd)
              const effectiveResumeId = CROSS_CWD_RESUME_OK[tab.type]
                ? preservedResumeId
                : undefined
              try {
                await restartAgentPtyWithHangGuard({
                  ptyId: tab.ptyId,
                  sessionPersistenceKey: tab.id,
                  agent: tab.type,
                  cwd: info.path,
                  runtimeProfile: tab.runtimeProfile,
                  extraArgs: tab.extraArgs ?? [],
                  resumeId: effectiveResumeId,
                  onSessionId: (id) =>
                    updateProject(projectId, (p) => ({
                      ...p,
                      terminals: p.terminals.map((t) =>
                        t.id !== terminal.id
                          ? t
                          : {
                              ...t,
                              tabs: t.tabs.map((tb) =>
                                tb.id === tab.id ? { ...tb, sessionId: id } : tb,
                              ),
                            },
                      ),
                    })),
                })
                window.dispatchEvent(
                  new CustomEvent('alethe:terminal-resize-request', {
                    detail: { ptyId: tab.ptyId },
                  }),
                )
              } catch (restartErr) {
                console.warn(
                  `[projectsStore] failed restarting tab in the new worktree (${terminal.name}):`,
                  restartErr,
                )
              }
            }

            succeeded.push(terminal.name)
          } catch (err) {
            failed.push({ name: terminal.name, error: String(err) })
          }
        }

        if (succeeded.length === 0 && failed.length === 0) {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateEmptyTitle'),
            body: t('multiAgent.migrateEmptyBody'),
          })
        } else if (failed.length === 0) {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateDoneTitle'),
            body: t('multiAgent.migrateDoneBody', { count: succeeded.length }),
          })
        } else if (succeeded.length === 0) {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migrateFailedTitle'),
            body: t('multiAgent.migrateFailedBody', { error: failed[0].error.slice(0, 200) }),
          })
        } else {
          useUiStore.getState().pushToast({
            title: t('multiAgent.migratePartialTitle'),
            body: t('multiAgent.migratePartialBody', {
              succeeded: succeeded.length,
              failed: failed.length,
              names: failed.map((f) => f.name).join(', '),
            }),
          })
        }
        return { status: 'done' }
      } finally {
        migratingWorktreeProjectIds.delete(projectId)
      }
    },

    addOrphanWorktree: (projectId, entry) =>
      updateProject(projectId, (p) => {
        const existing = p.orphanWorktrees ?? []
        const index = existing.findIndex((o) => o.path === entry.path)
        if (index === -1) {
          return { ...p, orphanWorktrees: [...existing, entry] }
        }
        const next = [...existing]
        next[index] = {
          ...existing[index],
          ...entry,

          adminLockReason: entry.adminLockReason,
        }
        return { ...p, orphanWorktrees: next }
      }),

    removeOrphanWorktree: (projectId, path) =>
      updateProject(projectId, (p) => ({
        ...p,
        orphanWorktrees: (p.orphanWorktrees ?? []).filter((o) => o.path !== path),
      })),

    setCleaningOrphans: (isCleaningOrphans) => update(() => ({ isCleaningOrphans })),

    cleanupOrphanWorktrees: async (projectId) => {
      const summary = { cleaned: 0, partial: 0, awaitingUnlock: 0, failed: 0 }
      const project = get().projects.find((p) => p.id === projectId)
      const repoPath = project?.terminals[0]?.cwd
      const orphans = project?.orphanWorktrees ?? []
      if (!project || !repoPath || orphans.length === 0) return summary

      const { worktreeCleanup, worktreeRemove } = await import('../lib/tauri')
      set({ isCleaningOrphans: true })

      for (const orphan of orphans) {
        try {
          if (orphan.pruneOnly) {
            // fantasma do git.
            await worktreeCleanup(repoPath)
            get().removeOrphanWorktree(projectId, orphan.path)
            summary.cleaned++
            continue
          }

          // requiresRawDeletion (ou nenhuma flag ainda — primeira tentativa):

          const agentId = orphan.path.split(/[\\/]/).filter(Boolean).pop() ?? ''
          await worktreeRemove(repoPath, agentId, true)

          try {
            await worktreeCleanup(repoPath)
            get().removeOrphanWorktree(projectId, orphan.path)
            summary.cleaned++
          } catch {
            get().addOrphanWorktree(projectId, {
              path: orphan.path,
              mode: orphan.mode,
              pruneOnly: true,
              requiresRawDeletion: undefined,
              cleanAttempts: 0,
              adminLockReason: undefined,
            })
            summary.partial++
          }
        } catch (error) {
          const message = String(error)
          const adminLockMatch = message.match(/admin_locked:(.*)$/)
          if (adminLockMatch) {
            get().addOrphanWorktree(projectId, {
              ...orphan,
              adminLockReason: adminLockMatch[1],
            })
            summary.awaitingUnlock++
          } else {
            get().addOrphanWorktree(projectId, {
              ...orphan,
              adminLockReason: undefined,
              cleanAttempts: (orphan.cleanAttempts ?? 0) + 1,
            })
            summary.failed++
          }
        }
      }

      set({ isCleaningOrphans: false })
      return summary
    },

    deleteProject: (id) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === id)
        if (!project) return
        cleanupPtys(collectTerminalPtyIds(project.terminals))
        const projects = state.projects.filter((p) => p.id !== id)
        const todos = state.todos.map((item) => {
          if (item.projectId !== id) return item
          const next = { ...item }
          delete next.projectId
          return next
        })
        const groups = state.groups.map((g) =>
          g.id === project.groupId
            ? { ...g, projectIds: g.projectIds.filter((pid) => pid !== id) }
            : g,
        )
        const ungroupedOrder = state.ungroupedOrder.filter((pid) => pid !== id)
        const containers = state.workspace.containers.filter((c) => c.projectId !== id)
        const recentProjectIds = (state.workspace.recentProjectIds ?? []).filter(
          (pid) => pid !== id,
        )
        const recentTabs = (state.workspace.recentTabs ?? []).filter(
          (tab) => !(tab.kind === 'project' && tab.id === id),
        )
        const activeProjectId =
          state.activeProjectId === id ? (projects[0]?.id ?? null) : state.activeProjectId
        const tabs = state.workspace.tabs
          .filter(
            (tab) =>
              !(tab.kind === 'project' && tab.sourceId === id) &&
              !(tab.kind === 'terminal' && tab.sourceProjectId === id),
          )
          .map((tab) => ({
            ...tab,
            snapshot: sanitizeWorkspaceSnapshot(tab.snapshot, projects),
          }))
        const tabIds = new Set(tabs.map((tab) => tab.id))
        const activeTabId = tabIds.has(state.workspace.activeTabId ?? '')
          ? state.workspace.activeTabId
          : (tabs[0]?.id ?? null)
        const history = state.workspace.history
          .filter((entry) => tabIds.has(entry.tabId))
          .map((entry) => ({
            ...entry,
            snapshot: sanitizeWorkspaceSnapshot(entry.snapshot, projects),
          }))
        return {
          projects,
          todos,
          groups,
          ungroupedOrder,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds,
            recentTabs,
            tabs,
            activeTabId,
            history,
            historyIndex: Math.min(state.workspace.historyIndex, history.length - 1),
          },
          activeProjectId,
        }
      }),
  }
}

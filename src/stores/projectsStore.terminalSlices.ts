/** Terminal and workspace-container actions extracted from the main store. */

import { nanoid } from 'nanoid'

import { getLocale, translate } from '../lib/i18n'
import {
  clearTerminalPtyIds,
  collectTerminalPtyIds,
  getProjectDefaultCwd,
  getProjectRepoRoot,
  makeDefaultTerminal,
  makeDiffPane,
  makeFilePane,
  makeWebPane,
  newContainer,
  rememberProjectTab,
  rememberWorkspaceTab,
  resetTerminalRuntime,
  touchTerminalUsage,
} from '../lib/terminalFactory'
import { cleanupPtys } from '../lib/terminalLifecycle'
import type { Terminal } from '../lib/types'
import { sanitizeWorkspaceSnapshot } from '../lib/workspaceNavigation'
import { useUiStore } from './uiStore'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

type TerminalsSlice = Pick<
  ProjectsState,
  | 'createTerminal'
  | 'createAgentTerminal'
  | 'createFilePane'
  | 'createDiffPane'
  | 'createWebPane'
  | 'createGraphifyPane'
  | 'renameTerminal'
  | 'setBrowserEngine'
  | 'markGsdSyncViewer'
  | 'deleteTerminal'
  | 'deleteTerminalWithWorktreeCleanup'
  | 'killTerminal'
  | 'moveTerminal'
  | 'setTerminalDisabled'
  | 'setProjectDisabled'
  | 'setLaneVisible'
  | 'setTerminalTopbarPinned'
  | 'setTerminalRemoteExcluded'
  | 'markTerminalUsed'
>

export function createTerminalsSlice({ get, update, updateTerminal }: SliceCtx): TerminalsSlice {
  return {
    createTerminal: (projectId, args) => {
      let terminal = makeDefaultTerminal(args)
      update((state) => {
        const sourceProject = state.projects.find((p) => p.id === projectId)
        const inheritedCwd = getProjectDefaultCwd(sourceProject)
        const finalCwd = args.cwd.trim() || inheritedCwd
        terminal = makeDefaultTerminal({
          ...args,
          cwd: finalCwd,
          firstTab: {
            ...args.firstTab,
            cwd: args.firstTab.cwd.trim() || finalCwd,
          },
        })
        const projects = state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                ...(!args.worktreeAgentId && finalCwd ? { defaultCwd: finalCwd } : {}),
                terminals: [...p.terminals, terminal],
              }
            : p,
        )
        const project = projects.find((p) => p.id === projectId)
        const layout = project?.layoutMode ?? 'auto'
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        const containers = existing
          ? state.workspace.containers.map((c) =>
              c.projectId === projectId
                ? { ...c, paneIds: [...c.paneIds, terminal.id], lastUsedAt: Date.now() }
                : c,
            )
          : [...state.workspace.containers, newContainer(projectId, [terminal.id], layout)]
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      })
      return terminal
    },

    createAgentTerminal: async (projectId, args) => {
      const state = get()
      const project = state.projects.find((p) => p.id === projectId)
      const wantsIsolation = Boolean(project?.autoWorktree) && args.firstTab.type !== 'shell'
      if (project && wantsIsolation) {
        // worktree_provision resolve a raiz de verdade via `--git-common-dir`

        const repo =
          getProjectRepoRoot(project) ||
          getProjectDefaultCwd(project, state.projects) ||
          args.cwd.trim()
        if (repo) {
          const agentId = `${args.firstTab.type.slice(0, 2)}-${nanoid(6)}`.replace(
            /[^A-Za-z0-9_-]/g,
            'x',
          )
          try {
            const { worktreeProvision, gitInit } = await import('../lib/tauri')

            try {
              await gitInit(repo)
            } catch (initErr) {
              console.warn('[projectsStore] auto-gitInit no spawn falhou:', initErr)
            }
            const info = await worktreeProvision(
              repo,
              agentId,
              project.worktreeMode ?? 'gitWorktree',
            )
            return get().createTerminal(projectId, {
              name: args.name,
              cwd: info.path,
              firstTab: { ...args.firstTab, cwd: info.path },
              worktreeAgentId: agentId,
            })
          } catch (error) {
            console.warn('[projectsStore] autoWorktree falhou; terminal normal:', error)
            useUiStore.getState().pushToast({
              title: t('term.autoIsolationFailedTitle'),
              body: t('term.autoIsolationFailedBody', { error: String(error).slice(0, 200) }),
            })
          }
        }
      }
      return get().createTerminal(projectId, args)
    },

    createFilePane: (projectId, args) => {
      const pane = makeFilePane(args)
      update((state) => {
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        const project = projects.find((p) => p.id === projectId)
        const layout = project?.layoutMode ?? 'auto'
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        const containers = existing
          ? state.workspace.containers.map((c) =>
              c.projectId === projectId
                ? { ...c, paneIds: [...c.paneIds, pane.id], lastUsedAt: Date.now() }
                : c,
            )
          : [...state.workspace.containers, newContainer(projectId, [pane.id], layout)]
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      })
      return pane
    },

    createDiffPane: (projectId, args) => {
      const pane = makeDiffPane(args)
      update((state) => {
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        const project = projects.find((p) => p.id === projectId)
        const layout = project?.layoutMode ?? 'auto'
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        const containers = existing
          ? state.workspace.containers.map((c) =>
              c.projectId === projectId
                ? { ...c, paneIds: [...c.paneIds, pane.id], lastUsedAt: Date.now() }
                : c,
            )
          : [...state.workspace.containers, newContainer(projectId, [pane.id], layout)]
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      })
      return pane
    },

    createWebPane: (projectId, args) => {
      const pane = makeWebPane(args)
      update((state) => {
        const projects = state.projects.map((project) =>
          project.id === projectId
            ? { ...project, terminals: [...project.terminals, pane] }
            : project,
        )
        const project = projects.find((entry) => entry.id === projectId)
        const layout = project?.layoutMode ?? 'auto'
        const existing = state.workspace.containers.find(
          (container) => container.projectId === projectId,
        )
        const containers = existing
          ? state.workspace.containers.map((container) =>
              container.projectId === projectId
                ? {
                    ...container,
                    paneIds: [...container.paneIds, pane.id],
                    lastUsedAt: Date.now(),
                  }
                : container,
            )
          : [...state.workspace.containers, newContainer(projectId, [pane.id], layout)]
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      })
      return pane
    },

    createGraphifyPane: (projectId, cwd) => {
      const pane: Terminal = {
        id: `graphify-${nanoid()}`,
        name: 'Visualização de Grafo (Graphify)',
        cwd,
        tabs: [],
        activeTabId: '',
        disabled: false,
        laneVisible: true,
        kind: 'graphify',
      }
      update((state) => {
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, pane] } : p,
        )
        const project = projects.find((p) => p.id === projectId)
        const layout = project?.layoutMode ?? 'auto'
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        const containers = existing
          ? state.workspace.containers.map((c) =>
              c.projectId === projectId
                ? { ...c, paneIds: [...c.paneIds, pane.id], lastUsedAt: Date.now() }
                : c,
            )
          : [...state.workspace.containers, newContainer(projectId, [pane.id], layout)]
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      })
      return pane
    },

    renameTerminal: (projectId, terminalId, name) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, name })),

    setBrowserEngine: (projectId, terminalId, engine) =>
      updateTerminal(projectId, terminalId, (t) => ({
        ...t,
        browserConfig: { ...t.browserConfig, engine },
      })),

    markGsdSyncViewer: (projectId, terminalId) =>
      updateTerminal(projectId, terminalId, (t) =>
        t.gsdSyncViewer ? t : { ...t, gsdSyncViewer: true },
      ),

    deleteTerminal: (projectId, terminalId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        const terminal = project?.terminals.find((t) => t.id === terminalId)

        // teardown da worktree inteira — arrasta junto o terminal "viewer" GSD

        const idsToRemove = new Set([terminalId])
        if (terminal?.worktreeAgentId && terminal.cwd) {
          for (const sibling of project?.terminals ?? []) {
            if (sibling.gsdSyncViewer && sibling.cwd === terminal.cwd) idsToRemove.add(sibling.id)
          }
        }
        const terminalsToClean = (project?.terminals ?? []).filter((t) => idsToRemove.has(t.id))
        if (terminalsToClean.length > 0) cleanupPtys(collectTerminalPtyIds(terminalsToClean))
        const projects = state.projects.map((p) => {
          if (p.id !== projectId) return p
          const paneGroups = (p.paneGroups ?? [])
            .map((group) => ({
              ...group,
              paneIds: group.paneIds.filter((id) => !idsToRemove.has(id)),
            }))
            .filter((group) => group.paneIds.length > 1)
          return {
            ...p,
            terminals: p.terminals.filter((t) => !idsToRemove.has(t.id)),
            paneGroups: paneGroups.length > 0 ? paneGroups : undefined,
          }
        })
        // remove pane do container; se container ficou vazio, remove container
        const containers = state.workspace.containers
          .map((c) => {
            if (c.projectId !== projectId) return c
            return { ...c, paneIds: c.paneIds.filter((id) => !idsToRemove.has(id)) }
          })
          .filter((c) => c.paneIds.length > 0)
        const tabs = state.workspace.tabs
          .filter(
            (tab) =>
              !(
                tab.kind === 'terminal' &&
                tab.sourceProjectId === projectId &&
                idsToRemove.has(tab.sourceId ?? '')
              ),
          )
          .map((tab) => ({
            ...tab,
            snapshot: sanitizeWorkspaceSnapshot(tab.snapshot, projects),
          }))
        const tabIds = new Set(tabs.map((tab) => tab.id))
        const history = state.workspace.history
          .filter((entry) => tabIds.has(entry.tabId))
          .map((entry) => ({
            ...entry,
            snapshot: sanitizeWorkspaceSnapshot(entry.snapshot, projects),
          }))
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            tabs,
            activeTabId: tabIds.has(state.workspace.activeTabId ?? '')
              ? state.workspace.activeTabId
              : (tabs[0]?.id ?? null),
            focusedTerminalId: idsToRemove.has(state.workspace.focusedTerminalId ?? '')
              ? null
              : state.workspace.focusedTerminalId,
            history,
            historyIndex: Math.min(state.workspace.historyIndex, history.length - 1),
          },
        }
      }),

    deleteTerminalWithWorktreeCleanup: async (projectId, terminalId) => {
      const project = get().projects.find((p) => p.id === projectId)
      const terminal = project?.terminals.find((t) => t.id === terminalId)
      if (!terminal?.worktreeAgentId) {
        get().deleteTerminal(projectId, terminalId)
        return
      }
      const { killPtyTree, worktreeRemove } = await import('../lib/tauri')
      const ptyIds = collectTerminalPtyIds([terminal])

      await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))
      const repo = getProjectRepoRoot(project)
      if (repo) {
        try {
          await worktreeRemove(repo, terminal.worktreeAgentId, true)
        } catch (firstErr) {
          if (!String(firstErr).includes('worktree_not_found')) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            try {
              await worktreeRemove(repo, terminal.worktreeAgentId, true)
            } catch (secondErr) {
              if (!String(secondErr).includes('worktree_not_found')) {
                get().addOrphanWorktree(projectId, {
                  path: terminal.cwd ?? '',
                  mode: 'gitWorktree',
                })
              }
              console.warn(
                '[projectsStore] falha removendo worktree ao deletar terminal:',
                secondErr,
              )
            }
          }
        }
      }
      get().deleteTerminal(projectId, terminalId)
    },

    killTerminal: (projectId, terminalId) =>
      update((state) => {
        const terminal = state.projects
          .find((p) => p.id === projectId)
          ?.terminals.find((t) => t.id === terminalId)
        if (terminal) cleanupPtys(collectTerminalPtyIds([terminal]))

        const projects = state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                terminals: p.terminals.map((t) =>
                  t.id === terminalId ? resetTerminalRuntime(t) : t,
                ),
              }
            : p,
        )
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === projectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            focusedTerminalId:
              state.workspace.focusedTerminalId === terminalId
                ? null
                : state.workspace.focusedTerminalId,
          },
        }
      }),

    moveTerminal: (fromProjectId, terminalId, toProjectId) => {
      if (fromProjectId === toProjectId) return
      update((state) => {
        const from = state.projects.find((p) => p.id === fromProjectId)
        if (!from) return
        const terminal = from.terminals.find((t) => t.id === terminalId)
        if (!terminal) return
        const projects = state.projects.map((p) => {
          if (p.id === fromProjectId) {
            return { ...p, terminals: p.terminals.filter((t) => t.id !== terminalId) }
          }
          if (p.id === toProjectId) {
            return { ...p, terminals: [...p.terminals, terminal] }
          }
          return p
        })
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === fromProjectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return { projects, workspace: { ...state.workspace, containers } }
      })
    },

    setTerminalDisabled: (projectId, terminalId, disabled) =>
      updateTerminal(projectId, terminalId, (t) => {
        if (disabled) {
          cleanupPtys(collectTerminalPtyIds([t]))
          return { ...clearTerminalPtyIds(t), disabled }
        }
        return { ...t, disabled }
      }),

    setProjectDisabled: (projectId, disabled) =>
      update((state) => {
        const projects = state.projects.map((p) => {
          if (p.id !== projectId) return p
          if (disabled) cleanupPtys(collectTerminalPtyIds(p.terminals))
          return {
            ...p,
            terminals: p.terminals.map((t) => ({
              ...(disabled ? clearTerminalPtyIds(t) : t),
              disabled,
            })),
          }
        })
        if (disabled) {
          const containers = state.workspace.containers.filter((c) => c.projectId !== projectId)
          return { projects, workspace: { ...state.workspace, containers } }
        }
        return { projects }
      }),

    setLaneVisible: (projectId, terminalId, visible) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, laneVisible: visible })),

    setTerminalTopbarPinned: (projectId, terminalId, pinned) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, topbarPinned: pinned })),

    setTerminalRemoteExcluded: (projectId, terminalId, excluded) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, remoteExcluded: excluded })),

    markTerminalUsed: (projectId, terminalId) =>
      updateTerminal(projectId, terminalId, (t) => touchTerminalUsage(t)),

    /* ------------ workspace containers ------------ */
  }
}

type ContainersSlice = Pick<
  ProjectsState,
  | 'openPane'
  | 'closePane'
  | 'togglePane'
  | 'openContainerWithAllPanes'
  | 'closeContainer'
  | 'closeOtherContainers'
  | 'reorderContainers'
  | 'reorderPaneInContainer'
  | 'groupPanes'
  | 'ungroupPanes'
  | 'setContainerCollapsed'
  | 'setContainerInternalLayout'
  | 'setFullscreenContainer'
  | 'setFullscreenPane'
  | 'setWorkspaceFlat'
>

export function createContainersSlice({ get, update, updateContainer }: SliceCtx): ContainersSlice {
  return {
    openPane: (projectId, terminalId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project) return
        const now = Date.now()
        const projects = state.projects.map((p) =>
          p.id !== projectId
            ? p
            : {
                ...p,
                terminals: p.terminals.map((t) =>
                  t.id === terminalId ? touchTerminalUsage(t) : t,
                ),
              },
        )
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        if (existing) {
          if (existing.paneIds.includes(terminalId)) {
            return {
              projects,
              workspace: {
                ...state.workspace,
                containers: state.workspace.containers.map((c) =>
                  c.projectId === projectId ? { ...c, lastUsedAt: now } : c,
                ),
                recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
                recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                  kind: 'project',
                  id: projectId,
                }),
              },
            }
          }
          return {
            projects,
            workspace: {
              ...state.workspace,
              containers: state.workspace.containers.map((c) =>
                c.projectId === projectId
                  ? { ...c, paneIds: [...c.paneIds, terminalId], lastUsedAt: now }
                  : c,
              ),
              recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'project',
                id: projectId,
              }),
            },
          }
        }
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers: [
              ...state.workspace.containers,
              newContainer(projectId, [terminalId], project.layoutMode),
            ],
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      }),

    closePane: (projectId, terminalId) =>
      update((state) => {
        const terminal = state.projects
          .find((p) => p.id === projectId)
          ?.terminals.find((t) => t.id === terminalId)
        if (terminal) cleanupPtys(collectTerminalPtyIds([terminal]))
        const projects = state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                terminals: p.terminals.map((t) =>
                  t.id === terminalId ? clearTerminalPtyIds(t) : t,
                ),
              }
            : p,
        )
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === projectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return { projects, workspace: { ...state.workspace, containers } }
      }),

    togglePane: (projectId, terminalId) => {
      const state = get()
      const c = state.workspace.containers.find((x) => x.projectId === projectId)
      if (c?.paneIds.includes(terminalId)) {
        get().closePane(projectId, terminalId)
      } else {
        get().openPane(projectId, terminalId)
      }
    },

    openContainerWithAllPanes: (projectId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project || project.terminals.length === 0) return
        const allPanes = project.terminals.map((t) => t.id)
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        // Sai do fullscreen se outro container estava bloqueando a vista
        const fsId = state.preferences.fullscreenContainerId
        const preferences =
          fsId && fsId !== projectId
            ? { ...state.preferences, fullscreenContainerId: null }
            : state.preferences
        if (existing) {
          return {
            preferences,
            workspace: {
              ...state.workspace,
              containers: state.workspace.containers.map((c) =>
                c.projectId === projectId
                  ? { ...c, paneIds: allPanes, collapsed: false, lastUsedAt: Date.now() }
                  : c,
              ),
              recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'project',
                id: projectId,
              }),
            },
          }
        }
        return {
          preferences,
          workspace: {
            ...state.workspace,
            containers: [
              ...state.workspace.containers,
              newContainer(projectId, allPanes, project.layoutMode),
            ],
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      }),

    closeContainer: (projectId) =>
      update((state) => {
        const closingPaneIds = new Set(
          state.workspace.containers.find((c) => c.projectId === projectId)?.paneIds ?? [],
        )
        const project = state.projects.find((p) => p.id === projectId)
        const closingTerminals = project?.terminals.filter((t) => closingPaneIds.has(t.id)) ?? []
        cleanupPtys(collectTerminalPtyIds(closingTerminals))
        return {
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  terminals: p.terminals.map((t) =>
                    closingPaneIds.has(t.id) ? clearTerminalPtyIds(t) : t,
                  ),
                }
              : p,
          ),
          workspace: {
            ...state.workspace,
            containers: state.workspace.containers.filter((c) => c.projectId !== projectId),
          },
        }
      }),

    closeOtherContainers: (keepProjectId) =>
      update((state) => {
        const closingContainers = state.workspace.containers.filter(
          (c) => c.projectId !== keepProjectId,
        )
        const closingByProject = new Map(
          closingContainers.map((c) => [c.projectId, new Set(c.paneIds)]),
        )
        const closingTerminals = state.projects.flatMap((project) => {
          const paneIds = closingByProject.get(project.id)
          if (!paneIds) return []
          return project.terminals.filter((terminal) => paneIds.has(terminal.id))
        })
        cleanupPtys(collectTerminalPtyIds(closingTerminals))
        return {
          projects: state.projects.map((project) => {
            const paneIds = closingByProject.get(project.id)
            if (!paneIds) return project
            return {
              ...project,
              terminals: project.terminals.map((terminal) =>
                paneIds.has(terminal.id) ? clearTerminalPtyIds(terminal) : terminal,
              ),
            }
          }),
          workspace: {
            ...state.workspace,
            containers: state.workspace.containers.filter((c) => c.projectId === keepProjectId),
          },
        }
      }),

    reorderContainers: (fromIndex, toIndex) =>
      update((state) => {
        const next = [...state.workspace.containers]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { workspace: { ...state.workspace, containers: next } }
      }),

    reorderPaneInContainer: (projectId, fromIndex, toIndex) =>
      updateContainer(projectId, (c) => {
        const next = [...c.paneIds]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { ...c, paneIds: next }
      }),

    groupPanes: (projectId, paneIds) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        const validIds = [...new Set(paneIds)].filter((id) =>
          project?.terminals.some((t) => t.id === id),
        )
        if (!project || validIds.length < 2) return
        const selected = new Set(validIds)
        const groups = project.paneGroups ?? []
        const absorbed = groups.filter((group) => group.paneIds.some((id) => selected.has(id)))
        const expandedIds = [
          ...new Set(absorbed.flatMap((group) => group.paneIds).concat(validIds)),
        ]
        const remaining = groups.filter((group) => !absorbed.includes(group))
        remaining.push({ id: `pane-group-${Date.now()}`, paneIds: expandedIds })
        return {
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, paneGroups: remaining } : p,
          ),
        }
      }),

    ungroupPanes: (projectId, groupId) =>
      update((state) => ({
        projects: state.projects.map((p) =>
          p.id === projectId
            ? { ...p, paneGroups: (p.paneGroups ?? []).filter((group) => group.id !== groupId) }
            : p,
        ),
      })),

    setContainerCollapsed: (projectId, collapsed) =>
      updateContainer(projectId, (c) => ({ ...c, collapsed })),

    setContainerInternalLayout: (projectId, layout) =>
      updateContainer(projectId, (c) => ({ ...c, internalLayout: layout })),

    setFullscreenContainer: (projectId) =>
      update((state) => ({
        preferences: {
          ...state.preferences,
          fullscreenContainerId: projectId,
          isolatedPaneId: null,
        },
      })),

    setFullscreenPane: (terminalId) =>
      update((state) => {
        if (!terminalId) {
          return {
            preferences: {
              ...state.preferences,
              fullscreenContainerId: null,
              isolatedPaneId: null,
            },
          }
        }
        const owner = state.projects.find((p) => p.terminals.some((term) => term.id === terminalId))
        if (!owner) return
        return {
          preferences: {
            ...state.preferences,
            fullscreenContainerId: owner.id,
            isolatedPaneId: terminalId,
          },
        }
      }),

    setWorkspaceFlat: (flat) =>
      update((state) => ({
        preferences: { ...state.preferences, workspaceFlat: flat },
      })),
  }
}

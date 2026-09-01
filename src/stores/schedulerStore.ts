import { create } from 'zustand'
import {
  getSchedulerTasks,
  triggerSchedulerTick,
  cancelTask,
  listenEventBus,
  publishEvent,
  type SchedulerTask,
} from '../lib/tauri'
import { useProjectsStore } from './projectsStore'
import { useUiStore } from './uiStore'
import { translate, getLocale } from '../lib/i18n'

type SchedulerState = {
  tasks: SchedulerTask[]
  loading: boolean
  activeProjectId: string | null
  /** taskId → terminalId do agente spawnado (para teardown/cancel). */
  taskTerminals: Record<string, string>

  loadTasks: (projectId: string) => Promise<void>
  tick: (projectId: string, repoPath: string) => Promise<void>
  cancel: (taskId: string) => Promise<void>
  initListener: () => () => void
}

/** Prompt inicial do agente de task GSD — aponta pro planejamento e trava escopo. */
function taskPrompt(taskTitle: string): string {
  return (
    `Sua tarefa: "${taskTitle}". Leia .planning/task.md, .planning/plan.md e ` +
    '.planning/goal.md do repositório original para o contexto completo, ' +
    'implemente SOMENTE essa tarefa neste diretório isolado e avise quando terminar.'
  )
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  tasks: [],
  loading: false,
  activeProjectId: null,
  taskTerminals: {},

  loadTasks: async (projectId) => {
    set({ loading: true, activeProjectId: projectId })
    try {
      const list = await getSchedulerTasks(projectId)
      set({ tasks: list })
    } catch (err) {
      console.error('[schedulerStore] Falha ao carregar tarefas do agendador:', err)
    } finally {
      set({ loading: false })
    }
  },

  tick: async (projectId, repoPath) => {
    try {
                                                                           
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      await triggerSchedulerTick(projectId, repoPath, project?.worktreeMode)
      const list = await getSchedulerTasks(projectId)
      set({ tasks: list })
    } catch (err) {
      console.error('[schedulerStore] Falha ao executar tick do agendador:', err)
    }
  },

  cancel: async (taskId) => {
    try {
      await cancelTask(taskId)
      // Teardown do terminal do agente, se houver.
      const { taskTerminals, activeProjectId } = get()
      const terminalId = taskTerminals[taskId]
      if (terminalId && activeProjectId) {
        useProjectsStore.getState().deleteTerminal(activeProjectId, terminalId)
        set((state) => {
          const next = { ...state.taskTerminals }
          delete next[taskId]
          return { taskTerminals: next }
        })
      }
                                                                                        
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId
            ? { ...t, status: 'failed', assignedAgentId: null, leaseResource: null }
            : t,
        ),
      }))
    } catch (err) {
      console.error('[schedulerStore] Falha ao cancelar tarefa:', err)
    }
  },

  initListener: () => {
    let active = true
    const unlistenPromise = listenEventBus((event) => {
      if (!active) return

                                                                               
                                                                              
      if (event.event_type === 'AgentSpawnRequested') {
        const projectId = event.task_id ?? null // scheduler publica project em task_id
        const taskId = String(event.agent_id ?? event.data?.task_id ?? '')
        const worktreePath = String(event.data?.worktree_path ?? '')
        const taskTitle = String(event.data?.task_title ?? taskId)
        // O scheduler usa (project_id → task_id do payload); confere os dois.
        const realTaskId = String(event.data?.task_id ?? taskId)
        if (!projectId || !worktreePath) return
        const projects = useProjectsStore.getState()
        const project = projects.projects.find((p) => p.id === projectId)
        if (!project) return
        if (get().taskTerminals[realTaskId]) return               
        const provider = project.conflictAgentProvider ?? 'claude'
        const terminal = projects.createTerminal(projectId, {
          name: taskTitle.slice(0, 40),
          cwd: worktreePath,
          firstTab: { type: provider, cwd: worktreePath, extraArgs: [taskPrompt(taskTitle)] },
        })
        set((state) => ({
          taskTerminals: { ...state.taskTerminals, [realTaskId]: terminal.id },
        }))
        // 2.4 — primeiro heartbeat do agente no bus (supervisor zera o timeout).
        void publishEvent({
          event_type: 'AgentHeartbeat',
          timestamp_ms: Date.now(),
          correlation_id: `sched-front-${realTaskId}`,
          task_id: realTaskId,
          agent_id: String(event.data?.agent_id ?? ''),
          data: { source: 'spawn' },
        }).catch(() => {})
        useUiStore.getState().pushToast({
          title: translate(getLocale(), 'scheduler.agentSpawnedTitle'),
          body: taskTitle,
        })
        void get().loadTasks(projectId)
        return
      }

      const { activeProjectId } = get()
                                                               
      if (
        event.event_type.startsWith('Task') ||
        event.event_type.startsWith('Agent') ||
        event.event_type === 'PlanningUpdated'
      ) {
        if (activeProjectId && event.task_id === activeProjectId) {
                            
          void get().loadTasks(activeProjectId)
        } else if (activeProjectId) {
                                                                
          const projId = event.data?.project_id || event.data?.projectId
          if (projId === activeProjectId) {
            void get().loadTasks(activeProjectId)
          }
        }
      }
    })

    return () => {
      active = false
      void unlistenPromise.then((unlisten) => unlisten())
    }
  },
}))

import { create } from 'zustand'

import {
  CHANGE_TRIGGER_EVENT,
  changeTriggerAcknowledge,
  type ChangeTriggerPayload,
} from '../lib/api/changeTrigger'
import { expected } from '../lib/resilience'
import { listenEventBus } from '../lib/tauri'

export type PendingChangeTrigger = {
  projectId: string
  fileCount: number
  firedAt: number
}

type ChangeTriggerState = {
  /** One pending trigger per project, keyed by project id. The backend will not fire again for a
   *  project while one is unanswered, so a second entry for the same project cannot appear. */
  pending: Record<string, PendingChangeTrigger>
  /** Project whose review popup is open, or null. Kept here rather than passed down as a prop:
   *  the badge lives in two separate sidebar implementations, and threading a callback through
   *  both only to reach one modal is more moving parts than the state itself. */
  openProjectId: string | null
  open: (projectId: string) => void
  dismiss: (projectId: string) => void
  clear: (projectId: string) => void
  initListener: () => () => void
}

export const useChangeTriggerStore = create<ChangeTriggerState>((set) => ({
  pending: {},
  openProjectId: null,

  open: (projectId) => set({ openProjectId: projectId }),

  /** The user was asked and said no. Acknowledging clears what accumulated in the backend, so the
   *  same batch is never raised twice — being asked again about work you already declined to
   *  describe is nagging, not a reminder. */
  dismiss: (projectId) => {
    void changeTriggerAcknowledge(projectId).catch((error) => {
      console.error(`[change-trigger] acknowledge failed for ${projectId}:`, error)
    })
    set((state) => {
      const { [projectId]: _removed, ...rest } = state.pending
      return {
        pending: rest,
        openProjectId: state.openProjectId === projectId ? null : state.openProjectId,
      }
    })
  },

  /** Drops the badge without acknowledging — for a project that disappeared, where there is no
   *  backend state left to clear. */
  clear: (projectId) =>
    set((state) => {
      const { [projectId]: _removed, ...rest } = state.pending
      return {
        pending: rest,
        openProjectId: state.openProjectId === projectId ? null : state.openProjectId,
      }
    }),

  initListener: () => {
    let active = true
    const unlistenPromise = listenEventBus((event) => {
      if (!active || event.event_type !== CHANGE_TRIGGER_EVENT) return
      const payload = event.data as unknown as ChangeTriggerPayload | undefined
      const projectId = payload?.projectId ?? event.task_id
      if (!projectId) {
        console.error('[change-trigger] fired event carried no project id:', event)
        return
      }
      set((state) => ({
        pending: {
          ...state.pending,
          [projectId]: {
            projectId,
            fileCount: payload?.fileCount ?? 0,
            firedAt: Date.now(),
          },
        },
      }))
    })
    return () => {
      active = false
      void unlistenPromise.then((unlisten) => unlisten()).catch(expected('unlisten_failed'))
    }
  },
}))

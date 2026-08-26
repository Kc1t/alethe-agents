import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type TaskVisibility = 'public' | 'restricted'
export type TaskStatus = 'open' | 'in_progress' | 'completed'

export type TaskComment = {
  authorDeviceId: string
  body: string
  createdAtMs: number
}

export type TaskRecord = {
  taskId: string
  projectId: string
  revision: number
  visibility: TaskVisibility
  restrictedMembers: string[]
  title: string
  body: string
  authorDeviceId: string
  assignees: string[]
  labels: string[]
  dueAtMs?: number | null
  status: TaskStatus
  comments: TaskComment[]
  createdAtMs: number
  updatedAtMs: number
  tombstoned: boolean
}

export async function syncCreateTask(
  projectId: string,
  deviceId: string,
  title: string,
  body: string,
  visibility: TaskVisibility,
  restrictedMembers: string[],
): Promise<TaskRecord> {
  if (isTauriEnv()) {
    return invoke<TaskRecord>('sync_create_task', {
      projectId,
      deviceId,
      title,
      body,
      visibility,
      restrictedMembers,
    })
  }
  return webApiFetch<TaskRecord>('/api/sync/tasks/create', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      deviceId,
      title,
      body,
      visibility,
      restrictedMembers,
    }),
  })
}

export async function syncListVisibleTasks(
  projectId: string,
  viewerDeviceId: string,
  viewerAccountRoute: string,
): Promise<TaskRecord[]> {
  if (isTauriEnv()) {
    return invoke<TaskRecord[]>('sync_list_visible_tasks', {
      projectId,
      viewerDeviceId,
      viewerAccountRoute,
    })
  }
  const params = new URLSearchParams({ projectId, viewerDeviceId, viewerAccountRoute })
  return webApiFetch<TaskRecord[]>(`/api/sync/tasks?${params.toString()}`)
}

export async function syncCompleteTask(
  projectId: string,
  taskId: string,
  deviceId: string,
  expectedBaseRevision: number,
): Promise<TaskRecord> {
  if (isTauriEnv()) {
    return invoke<TaskRecord>('sync_complete_task', {
      projectId,
      taskId,
      deviceId,
      expectedBaseRevision,
    })
  }
  return webApiFetch<TaskRecord>('/api/sync/tasks/complete', {
    method: 'POST',
    body: JSON.stringify({ projectId, taskId, deviceId, expectedBaseRevision }),
  })
}

export async function syncReopenTask(
  projectId: string,
  taskId: string,
  deviceId: string,
  expectedBaseRevision: number,
): Promise<TaskRecord> {
  if (isTauriEnv()) {
    return invoke<TaskRecord>('sync_reopen_task', {
      projectId,
      taskId,
      deviceId,
      expectedBaseRevision,
    })
  }
  return webApiFetch<TaskRecord>('/api/sync/tasks/reopen', {
    method: 'POST',
    body: JSON.stringify({ projectId, taskId, deviceId, expectedBaseRevision }),
  })
}

export async function syncAddTaskComment(
  projectId: string,
  taskId: string,
  deviceId: string,
  expectedBaseRevision: number,
  body: string,
): Promise<TaskRecord> {
  if (isTauriEnv()) {
    return invoke<TaskRecord>('sync_add_task_comment', {
      projectId,
      taskId,
      deviceId,
      expectedBaseRevision,
      body,
    })
  }
  return webApiFetch<TaskRecord>('/api/sync/tasks/comment', {
    method: 'POST',
    body: JSON.stringify({ projectId, taskId, deviceId, expectedBaseRevision, body }),
  })
}

export async function syncUpdateTask(
  projectId: string,
  taskId: string,
  deviceId: string,
  expectedBaseRevision: number,
  changes: { title?: string; body?: string; labels?: string[]; dueAtMs?: number | null },
): Promise<TaskRecord> {
  if (isTauriEnv()) {
    return invoke<TaskRecord>('sync_update_task', {
      projectId,
      taskId,
      deviceId,
      expectedBaseRevision,
      title: changes.title,
      body: changes.body,
      labels: changes.labels,
      dueAtMs: 'dueAtMs' in changes ? changes.dueAtMs : undefined,
    })
  }
  return webApiFetch<TaskRecord>('/api/sync/tasks/update', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      taskId,
      deviceId,
      expectedBaseRevision,
      title: changes.title,
      body: changes.body,
      labels: changes.labels,
      dueAtMs: 'dueAtMs' in changes ? changes.dueAtMs : undefined,
    }),
  })
}

export async function syncAssignTask(
  projectId: string,
  taskId: string,
  deviceId: string,
  expectedBaseRevision: number,
  assignees: string[],
): Promise<TaskRecord> {
  if (isTauriEnv()) {
    return invoke<TaskRecord>('sync_assign_task', {
      projectId,
      taskId,
      deviceId,
      expectedBaseRevision,
      assignees,
    })
  }
  return webApiFetch<TaskRecord>('/api/sync/tasks/assign', {
    method: 'POST',
    body: JSON.stringify({ projectId, taskId, deviceId, expectedBaseRevision, assignees }),
  })
}

export async function syncDeleteTask(
  projectId: string,
  taskId: string,
  deviceId: string,
  expectedBaseRevision: number,
): Promise<TaskRecord> {
  if (isTauriEnv()) {
    return invoke<TaskRecord>('sync_delete_task', {
      projectId,
      taskId,
      deviceId,
      expectedBaseRevision,
    })
  }
  return webApiFetch<TaskRecord>('/api/sync/tasks/delete', {
    method: 'POST',
    body: JSON.stringify({ projectId, taskId, deviceId, expectedBaseRevision }),
  })
}

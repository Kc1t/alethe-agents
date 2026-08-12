import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type GraphifyStatus = { available: boolean; command: string; version?: string }
export type GraphNode = { id: string; label: string; kind?: string; group?: string }
export type GraphEdge = { id: string; source: string; target: string; label?: string }
export type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  nodeCount: number
  edgeCount: number
  truncated: boolean
}
export type GraphSnapshotInfo = { id: string; path: string; createdMs: number; sizeBytes: number }

export async function graphifyDetect(command?: string): Promise<GraphifyStatus> {
  if (isTauriEnv()) return invoke<GraphifyStatus>('graphify_detect', { command })
  return webApiFetch<GraphifyStatus>(
    `/api/graphify/detect${command ? `?command=${encodeURIComponent(command)}` : ''}`,
  )
}

export async function graphifyEnsureGraph(
  repo: string,
  command?: string,
): Promise<'exists' | 'generating' | 'started' | 'unavailable'> {
  if (isTauriEnv())
    return invoke<'exists' | 'generating' | 'started' | 'unavailable'>('graphify_ensure_graph', {
      repo,
      command,
    })
  return webApiFetch<'exists' | 'generating' | 'started' | 'unavailable'>(
    '/api/graphify/ensure_graph',
    { method: 'POST', body: JSON.stringify({ repo, command }) },
  )
}

export async function graphifyMcpConfigPath(repo: string, command?: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('graphify_mcp_config_path', { repo, command })
  return webApiFetch<string>(`/api/graphify/mcp_config_path?repo=${encodeURIComponent(repo)}`)
}

export async function graphifyOpenCodeConfigWrite(repo: string, command?: string): Promise<void> {
  if (isTauriEnv()) return invoke('graphify_opencode_config_write', { repo, command })
  await webApiFetch('/api/graphify/opencode_config_write', {
    method: 'POST',
    body: JSON.stringify({ repo, command }),
  })
}

export async function graphifyCodexConfigWrite(repo: string, command?: string): Promise<void> {
  if (isTauriEnv()) return invoke('graphify_codex_config_write', { repo, command })
  await webApiFetch('/api/graphify/codex_config_write', {
    method: 'POST',
    body: JSON.stringify({ repo, command }),
  })
}

export async function graphifyReadGraph(repo: string): Promise<GraphData> {
  if (isTauriEnv()) return invoke<GraphData>('graphify_read_graph', { repo })
  return webApiFetch<GraphData>(`/api/graphify/read_graph?repo=${encodeURIComponent(repo)}`)
}

export async function graphifySnapshot(
  repo: string,
  projectId?: string,
): Promise<GraphSnapshotInfo> {
  if (isTauriEnv()) return invoke<GraphSnapshotInfo>('graphify_snapshot', { repo, projectId })
  return webApiFetch<GraphSnapshotInfo>('/api/graphify/snapshot', {
    method: 'POST',
    body: JSON.stringify({ repo, projectId }),
  })
}

export async function graphifyListSnapshots(repo: string): Promise<GraphSnapshotInfo[]> {
  if (isTauriEnv()) return invoke<GraphSnapshotInfo[]>('graphify_list_snapshots', { repo })
  return webApiFetch<GraphSnapshotInfo[]>(
    `/api/graphify/snapshots?repo=${encodeURIComponent(repo)}`,
  )
}

export async function graphifyDiffSnapshot(
  repo: string,
  baseId: string,
  targetId: string,
): Promise<GraphData> {
  if (isTauriEnv()) return invoke<GraphData>('graphify_diff_snapshot', { repo, baseId, targetId })
  return webApiFetch<GraphData>(
    `/api/graphify/diff_snapshot?repo=${encodeURIComponent(repo)}&baseId=${encodeURIComponent(baseId)}&targetId=${encodeURIComponent(targetId)}`,
  )
}

export async function graphifyRollback(
  repo: string,
  snapshotId: string,
  projectId?: string,
): Promise<void> {
  if (isTauriEnv()) return invoke('graphify_rollback', { repo, snapshotId, projectId })
  await webApiFetch('/api/graphify/rollback', {
    method: 'POST',
    body: JSON.stringify({ repo, snapshotId, projectId }),
  })
}

export async function graphifyPruneSnapshots(
  repo: string,
  keepLast: number,
  maxAgeDays?: number,
  projectId?: string,
): Promise<void> {
  if (isTauriEnv())
    return invoke('graphify_prune_snapshots', { repo, keepLast, maxAgeDays, projectId })
  await webApiFetch('/api/graphify/prune_snapshots', {
    method: 'POST',
    body: JSON.stringify({ repo, keepLast, maxAgeDays, projectId }),
  })
}

import { invoke } from '@tauri-apps/api/core'

// --- RFC-004 — Graphify ---

export type GraphifyStatus = {
  available: boolean
  command: string
  version?: string
}

export type GraphNode = {
  id: string
  label: string
  kind?: string
  group?: string
}

export type GraphEdge = {
  id: string
  source: string
  target: string
  label?: string
}

export type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  nodeCount: number
  edgeCount: number
  truncated: boolean
}

export type GraphSnapshotInfo = {
  id: string
  path: string
  createdMs: number
  sizeBytes: number
}

export async function graphifyDetect(command?: string): Promise<GraphifyStatus> {
  return invoke<GraphifyStatus>('graphify_detect', { command })
}

export async function graphifyEnsureGraph(
  repo: string,
  command?: string,
): Promise<'exists' | 'generating' | 'started' | 'unavailable'> {
  return invoke<'exists' | 'generating' | 'started' | 'unavailable'>('graphify_ensure_graph', {
    repo,
    command,
  })
}

export async function graphifyMcpConfigPath(repo: string, command?: string): Promise<string> {
  return invoke<string>('graphify_mcp_config_path', { repo, command })
}

export async function graphifyOpenCodeConfigWrite(repo: string, command?: string): Promise<void> {
  await invoke('graphify_opencode_config_write', { repo, command })
}

export async function graphifyCodexConfigWrite(repo: string, command?: string): Promise<void> {
  await invoke('graphify_codex_config_write', { repo, command })
}

export async function graphifyReadGraph(repo: string): Promise<GraphData> {
  return invoke<GraphData>('graphify_read_graph', { repo })
}

export async function graphifySnapshot(
  repo: string,
  projectId?: string,
): Promise<GraphSnapshotInfo> {
  return invoke<GraphSnapshotInfo>('graphify_snapshot', { repo, projectId })
}

export async function graphifyListSnapshots(repo: string): Promise<GraphSnapshotInfo[]> {
  return invoke<GraphSnapshotInfo[]>('graphify_list_snapshots', { repo })
}

export async function graphifyDiffSnapshot(
  repo: string,
  baseId: string,
  targetId: string,
): Promise<GraphData> {
  return invoke<GraphData>('graphify_diff_snapshot', { repo, baseId, targetId })
}

export async function graphifyRollback(
  repo: string,
  snapshotId: string,
  projectId?: string,
): Promise<void> {
  await invoke('graphify_rollback', { repo, snapshotId, projectId })
}

export async function graphifyPruneSnapshots(
  repo: string,
  keepLast: number,
  maxAgeDays?: number,
  projectId?: string,
): Promise<void> {
  await invoke('graphify_prune_snapshots', { repo, keepLast, maxAgeDays, projectId })
}

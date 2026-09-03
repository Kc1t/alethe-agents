import type { PluginManifest } from '../../lib/tauri'

export const GIT_CONTROL_MANIFEST: PluginManifest = {
  id: 'alethe.git-control',
  name: 'Git Control',
  version: '1.0.0',
  kind: 'ui',
  apiVersion: 1,
  description: 'Source control panel: status, staging, commits, branches and the commit graph.',
  capabilities: ['ui.sidebarTab', 'ui.command', 'invoke:git_*', 'invoke:worktree_*'],
  spec: {},
}

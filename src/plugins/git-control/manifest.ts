import type { PluginManifest } from '../../lib/tauri'

export const GIT_CONTROL_MANIFEST: PluginManifest = {
  id: 'alethe.git-control',
  name: 'Git Control',
  version: '1.0.0',
  kind: 'ui',
  apiVersion: 1,
  description: 'Source control panel: status, staging, commits, branches and the commit graph.',
  capabilities: ['ui.sidebarTab', 'ui.command', 'invoke:git_*', 'invoke:worktree_*'],
  activation: ['onView:git', 'onCommand:git.reveal'],
  contributes: {
    views: [
      {
        id: 'git',
        container: 'leftSidebar',
        title: 'Source Control',
        titleKey: 'ui.sidebar.git',
        panelTitleKey: 'ui.sidebar.sourceControl',
        icon: 'git-branch',
        order: 10,
      },
    ],
    commands: [
      {
        id: 'git.reveal',
        title: 'Source Control',
        titleKey: 'ui.sidebar.sourceControl',
        icon: 'git-branch',
        keywords: 'git source control commit branch diff status',
      },
    ],
  },
  spec: {},
}

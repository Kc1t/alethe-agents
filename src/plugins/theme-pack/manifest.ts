import type { PluginManifest } from '../../lib/tauri'

export const THEME_PACK_MANIFEST: PluginManifest = {
  id: 'alethe.theme-pack',
  name: 'Theme Pack',
  version: '1.0.0',
  kind: 'theme',
  apiVersion: 1,
  description: 'Ember, Golden Premium, Dark Lemon and Orca.',
  capabilities: ['ui.theme'],
  spec: {},
}

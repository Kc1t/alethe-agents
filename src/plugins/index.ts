import type { PluginModule } from '../lib/plugins/types'
import type { PluginManifest } from '../lib/tauri'
import { GIT_CONTROL_MANIFEST } from './git-control/manifest'
import { THEME_PACK_MANIFEST } from './theme-pack/manifest'

export type BundledPlugin = {
  manifest: PluginManifest
  /** Code-split entry. Same origin, so it needs no CSP allowance. */
  load: () => Promise<PluginModule>
}

/**
 * Official plugins shipped inside the app. They are installed by default and
 * can be disabled, and go through the same activation contract as any other
 * plugin — only their transport differs.
 */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    manifest: THEME_PACK_MANIFEST,
    load: () => import('./theme-pack/main').then((module) => module.default),
  },
  {
    manifest: GIT_CONTROL_MANIFEST,
    load: () => import('./git-control/main').then((module) => module.default),
  },
]

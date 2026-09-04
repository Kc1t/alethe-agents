import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

/** How OpenCode found the plugin. `directory` means it sits in the auto-loaded `plugin/` folder and
 *  needs no declaration; `declared` means it is named in the `plugin` array of `opencode.json` and
 *  loads only because of that entry. */
export type PluginOrigin = 'directory' | 'declared'

/** `alethe` is the configuration Alethe hands its agents — the one that decides what actually
 *  loads here. `user` is the machine's own OpenCode configuration, shown for comparison and as the
 *  source for importing; plugins there are NOT loaded by agents started from Alethe. */
export type PluginScope = 'alethe' | 'user'

export type PluginSummary = {
  name: string
  agent: string
  path: string
  origin: PluginOrigin
  scope: PluginScope
  /** False when the configuration names a path that is not on disk — the entry looks installed and
   *  loads nothing. */
  exists: boolean
  size: number
  /** Written and rewritten by Alethe on every launch; editing it would be undone silently. */
  managed: boolean
}

export type PluginScopeSnapshot = {
  agent: string
  scope: PluginScope
  /** Directory that was scanned, so an empty result can be explained rather than just shown empty. */
  root: string | null
  exists: boolean
  plugins: PluginSummary[]
}

export type PluginDetail = {
  summary: PluginSummary
  source: string
  /** True when `source` is only the head of the file. */
  truncated: boolean
}

/** Per-plugin result, shaped like `SkillSyncOutcome` and `McpSyncOutcome` so all three panels can
 *  report a copy the same way. */
export type PluginImportOutcome = {
  name: string
  status: 'ok' | 'skipped' | 'failed'
  reason: string | null
  path: string | null
}

export async function pluginsScan(): Promise<PluginScopeSnapshot[]> {
  if (isTauriEnv()) return invoke<PluginScopeSnapshot[]>('plugins_scan')
  return webApiFetch<PluginScopeSnapshot[]>('/api/plugins/scan')
}

export async function pluginsDetail(path: string): Promise<PluginDetail> {
  if (isTauriEnv()) return invoke<PluginDetail>('plugins_detail', { path })
  return webApiFetch<PluginDetail>(`/api/plugins/detail?path=${encodeURIComponent(path)}`)
}

/** Copies plugins from the machine's OpenCode configuration into Alethe's, which is what makes them
 *  load for agents started here. Being in the folder is all it takes — there is no registration
 *  step — so the import takes effect on the next launch. Without `overwrite`, a plugin already
 *  there comes back as `skipped` rather than being silently replaced. */
export async function pluginsImport(
  names: string[],
  overwrite = false,
): Promise<PluginImportOutcome[]> {
  if (isTauriEnv()) return invoke<PluginImportOutcome[]>('plugins_import', { names, overwrite })
  return webApiFetch<PluginImportOutcome[]>('/api/plugins/import', {
    method: 'POST',
    body: JSON.stringify({ names, overwrite }),
  })
}

import type { DialogFilter } from '@tauri-apps/plugin-dialog'

import { resolveAgentCliCommand } from './agentProviders'
import { getLocale, translate } from './i18n'
import { basename } from './paths'
import { isWindows } from './platform'
import type { AgentType } from './types'

const EXECUTABLE_SUFFIX = /\.(cmd|exe|bat|ps1)$/i

/**
 * Whether the picked file looks like the agent's CLI rather than something else that carries the
 * vendor's name. Antigravity is the case this exists for: its CLI is `agy`, while `antigravity.exe`
 * is the desktop app — pointing an override at the app launches a window instead of a terminal.
 */
export function cliPathMatchesAgent(agent: AgentType, path: string): boolean {
  const expected = resolveAgentCliCommand(agent)
  if (!expected) return true
  const file = basename(path).toLowerCase().replace(EXECUTABLE_SUFFIX, '')
  return file === expected.toLowerCase()
}

/**
 * File-picker filters for choosing an agent's CLI. Windows launchers carry an extension; Linux and
 * macOS binaries usually have none, and the GTK picker turns every filter into `*.ext`, which would
 * hide `claude` or `codex` behind a filter that cannot match them.
 */
export function cliExecutableFilters(): DialogFilter[] | undefined {
  if (!isWindows()) return undefined
  return [
    {
      name: translate(getLocale(), 'prefs.cliPathFilterExecutable'),
      extensions: ['cmd', 'exe', 'bat', 'ps1'],
    },
    { name: translate(getLocale(), 'prefs.cliPathFilterAll'), extensions: ['*'] },
  ]
}

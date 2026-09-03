/**
 * Capability matching for plugin manifests.
 *
 * A capability is either an exact token (`ui.pane`) or a prefix followed by a
 * single trailing `*` (`invoke:git_*`). A bare `*` is never a wildcard for a
 * whole namespace — `invoke:*` has to be written out, and is accepted, but
 * `*` alone is rejected so no manifest can claim everything by accident.
 */

const CAPABILITY_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*(?::[A-Za-z0-9_.-]*)?\*?$/

export function isValidCapability(capability: string): boolean {
  if (capability === '*' || capability.length === 0) return false
  if (capability.indexOf('*') !== -1 && !capability.endsWith('*')) return false
  return CAPABILITY_PATTERN.test(capability)
}

export function capabilityMatches(capability: string, request: string): boolean {
  if (!isValidCapability(capability)) return false
  if (capability.endsWith('*')) {
    const prefix = capability.slice(0, -1)
    // `invoke:*` must not match `ui.pane`; the prefix carries the namespace.
    return prefix.length > 0 && request.startsWith(prefix)
  }
  return capability === request
}

export function grants(capabilities: readonly string[], request: string): boolean {
  return capabilities.some((capability) => capabilityMatches(capability, request))
}

/** Commands a plugin may never reach, whatever it declares. */
const FORBIDDEN_COMMANDS = new Set([
  'spawn_pty',
  'write_pty',
  'restart_pty',
  'run_validation',
  'plugin_install',
  'plugin_uninstall',
  'plugin_set_enabled',
  'save_projects',
  'write_text_file',
  'delete_filesystem_entry',
  'mcp_reveal_env',
  'remote_control_open_pairing',
])

export function canInvoke(capabilities: readonly string[], command: string): boolean {
  if (FORBIDDEN_COMMANDS.has(command)) return false
  return grants(capabilities, `invoke:${command}`)
}

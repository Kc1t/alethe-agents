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
  'plugin_import_dir',
  'plugin_set_enabled',
  // Reachable only through `context.storage`, which binds the caller's own id.
  // Left invokable, a plugin could read and overwrite another plugin's record.
  'plugin_storage_read',
  'plugin_storage_write',
  // Opens a browser window; nothing a plugin needs, and a cheap way to nag.
  'plugin_catalog_open',
  'save_projects',
  'write_text_file',
  'delete_filesystem_entry',
  'mcp_reveal_env',
  // Replaces the remote 9router key in the OS keychain.
  'router9_set_remote_key',
  // Voice keys and servers are managed only in Preferences -> Voice.
  'voice_provider_set_key',
  'voice_provider_delete_key',
  'voice_servers_save',
  'voice_servers_delete',
  // Reachable only through context.agents and context.voice, behind agent.approve.
  'agent_permission_decide',
  'voice_set_targets',
  'remote_control_open_pairing',
])

export function canInvoke(capabilities: readonly string[], command: string): boolean {
  if (FORBIDDEN_COMMANDS.has(command)) return false
  return grants(capabilities, `invoke:${command}`)
}

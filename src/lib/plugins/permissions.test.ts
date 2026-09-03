import { describe, expect, it } from 'vitest'

import { canInvoke, capabilityMatches, grants, isValidCapability } from './permissions'

describe('isValidCapability', () => {
  it('accepts exact tokens and trailing wildcards', () => {
    expect(isValidCapability('ui.theme')).toBe(true)
    expect(isValidCapability('ui.sidebarTab')).toBe(true)
    expect(isValidCapability('invoke:git_status')).toBe(true)
    expect(isValidCapability('invoke:git_*')).toBe(true)
    expect(isValidCapability('invoke:*')).toBe(true)
  })

  it('rejects a blanket wildcard and mid-string wildcards', () => {
    expect(isValidCapability('*')).toBe(false)
    expect(isValidCapability('')).toBe(false)
    expect(isValidCapability('invoke:*_status')).toBe(false)
    expect(isValidCapability('Invoke:git_status')).toBe(false)
    expect(isValidCapability('invoke git_status')).toBe(false)
  })
})

describe('capabilityMatches', () => {
  it('matches exactly when there is no wildcard', () => {
    expect(capabilityMatches('invoke:git_status', 'invoke:git_status')).toBe(true)
    expect(capabilityMatches('invoke:git_status', 'invoke:git_commit')).toBe(false)
  })

  it('matches by prefix on a trailing wildcard', () => {
    expect(capabilityMatches('invoke:git_*', 'invoke:git_commit')).toBe(true)
    expect(capabilityMatches('invoke:git_*', 'invoke:worktree_list')).toBe(false)
  })

  it('keeps namespaces apart', () => {
    expect(capabilityMatches('invoke:*', 'ui.theme')).toBe(false)
    expect(capabilityMatches('invoke:*', 'invoke:anything')).toBe(true)
  })

  it('never honours an invalid pattern', () => {
    expect(capabilityMatches('*', 'invoke:git_status')).toBe(false)
  })
})

describe('canInvoke', () => {
  it('allows a declared command', () => {
    expect(canInvoke(['invoke:git_*'], 'git_status')).toBe(true)
  })

  it('denies an undeclared command', () => {
    expect(canInvoke(['invoke:git_*'], 'worktree_list')).toBe(false)
    expect(canInvoke([], 'git_status')).toBe(false)
  })

  it('denies forbidden commands even when the manifest claims them', () => {
    for (const command of [
      'spawn_pty',
      'write_pty',
      'run_validation',
      'save_projects',
      'write_text_file',
      'delete_filesystem_entry',
      'mcp_reveal_env',
      'plugin_set_enabled',
    ]) {
      expect(canInvoke(['invoke:*'], command)).toBe(false)
    }
  })
})

describe('grants', () => {
  it('is satisfied by any matching capability in the list', () => {
    expect(grants(['ui.theme', 'invoke:git_*'], 'ui.theme')).toBe(true)
    expect(grants(['ui.theme'], 'ui.pane')).toBe(false)
  })
})

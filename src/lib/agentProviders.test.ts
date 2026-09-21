import { afterEach, describe, expect, it } from 'vitest'

import {
  agentAccentToken,
  agentAccentVar,
  agentLabel,
  agentProviderContributions,
  allAgentTypes,
  findAgentProvider,
  isAgentEnabled,
  isBuiltinAgentType,
  isKnownAgentType,
  parseAgentType,
  resolveAgentCliCommand,
  resolveUnrestrictedFlag,
  type AgentProviderContribution,
} from './agentProviders'
import type { Disposable } from './plugins/types'

const AIDER: AgentProviderContribution = {
  id: 'aider-plus',
  label: 'Aider Plus',
  cliCommand: 'aider-plus-cli',
  unrestrictedFlag: '--force',
  accentToken: '--agent-aider-plus',
}

const registered: Disposable[] = []

function register(contribution: AgentProviderContribution): Disposable {
  const handle = agentProviderContributions.add('test-plugin', contribution)
  registered.push(handle)
  return handle
}

afterEach(() => {
  while (registered.length) registered.pop()?.dispose()
})

describe('builtin agent types', () => {
  it('resolves labels, CLI commands and unrestricted flags from the built-in tables', () => {
    expect(isBuiltinAgentType('claude')).toBe(true)
    expect(agentLabel('claude')).toBe('Claude Code')
    expect(resolveAgentCliCommand('claude')).toBe('claude')
    expect(resolveUnrestrictedFlag('claude')).toBe('--dangerously-skip-permissions')

    expect(resolveAgentCliCommand('antigravity')).toBe('agy')
    expect(resolveAgentCliCommand('kiro')).toBe('kiro-cli')
    expect(resolveAgentCliCommand('shell')).toBeUndefined()
    expect(resolveUnrestrictedFlag('shell')).toBeNull()
    expect(agentAccentToken('claude')).toBe('--agent-claude')
  })

  it('lists every built-in before any contribution', () => {
    expect(allAgentTypes()).toContain('shell')
    register(AIDER)
    expect(allAgentTypes().at(-1)).toBe('aider-plus')
  })
})

describe('contributed agent providers', () => {
  it('resolves everything the contribution declares', () => {
    register(AIDER)

    expect(isBuiltinAgentType('aider-plus')).toBe(false)
    expect(isKnownAgentType('aider-plus')).toBe(true)
    expect(findAgentProvider('aider-plus')?.label).toBe('Aider Plus')
    expect(agentLabel('aider-plus')).toBe('Aider Plus')
    expect(resolveAgentCliCommand('aider-plus')).toBe('aider-plus-cli')
    expect(resolveUnrestrictedFlag('aider-plus')).toBe('--force')
    expect(agentAccentToken('aider-plus')).toBe('--agent-aider-plus')
    expect(allAgentTypes()).toContain('aider-plus')
  })

  it('falls back per field when the contribution omits it', () => {
    register({ id: 'aider', label: 'Aider' })

    expect(resolveAgentCliCommand('aider')).toBeUndefined()
    expect(resolveUnrestrictedFlag('aider')).toBeNull()
    expect(agentAccentToken('aider')).toBe('--agent-shell')
  })

  it('ignores an accent token that is not a custom property', () => {
    register({ id: 'weird', label: 'Weird', accentToken: 'agent-weird' })

    expect(agentAccentToken('weird')).toBe('--agent-shell')
  })

  it('stops resolving once the contribution is disposed', () => {
    const handle = register(AIDER)
    expect(isKnownAgentType('aider-plus')).toBe(true)

    handle.dispose()

    expect(isKnownAgentType('aider-plus')).toBe(false)
    expect(findAgentProvider('aider-plus')).toBeUndefined()
    expect(agentLabel('aider-plus')).toBe('aider-plus')
    expect(resolveAgentCliCommand('aider-plus')).toBeUndefined()
    expect(allAgentTypes()).not.toContain('aider-plus')
    expect(parseAgentType('aider-plus')).toBeNull()
  })
})

describe('unknown agent ids', () => {
  it('degrades to the id, no command, no flag and the default accent', () => {
    expect(isKnownAgentType('nonesuch')).toBe(false)
    expect(agentLabel('nonesuch')).toBe('nonesuch')
    expect(resolveAgentCliCommand('nonesuch')).toBeUndefined()
    expect(resolveUnrestrictedFlag('nonesuch')).toBeNull()
    expect(agentAccentToken('nonesuch')).toBe('--agent-shell')
    expect(agentAccentVar('nonesuch')).toBe('var(--agent-shell, var(--agent-shell))')
  })
})

describe('parseAgentType', () => {
  it('accepts built-ins and rejects anything unknown', () => {
    expect(parseAgentType('claude')).toBe('claude')
    expect(parseAgentType('  CODEX  ')).toBe('codex')
    expect(parseAgentType('nonesuch')).toBeNull()
    expect(parseAgentType('')).toBeNull()
    expect(parseAgentType(null)).toBeNull()
    expect(parseAgentType(undefined)).toBeNull()
  })

  it('accepts a contributed id, including one that is not lowercase', () => {
    register(AIDER)
    register({ id: 'Zed', label: 'Zed' })

    expect(parseAgentType('aider-plus')).toBe('aider-plus')
    expect(parseAgentType(' AIDER-PLUS ')).toBe('aider-plus')
    expect(parseAgentType('Zed')).toBe('Zed')
  })
})

describe('isAgentEnabled', () => {
  it('honours the stored flag and defaults contributed providers to on', () => {
    register(AIDER)

    expect(isAgentEnabled({ claude: true }, 'claude')).toBe(true)
    expect(isAgentEnabled({ claude: false }, 'claude')).toBe(false)
    expect(isAgentEnabled({}, 'claude')).toBe(false)
    expect(isAgentEnabled({}, 'aider-plus')).toBe(true)
    expect(isAgentEnabled({ 'aider-plus': false }, 'aider-plus')).toBe(false)
  })
})

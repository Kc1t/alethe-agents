import { describe, expect, it } from 'vitest'

import {
  agentLabel,
  allAgentTypes,
  isKnownAgentType,
  resolveAgentCliCommand,
  resolveCustomAgentArgs,
  resolveUnrestrictedFlag,
  syncCustomAgentProviders,
} from './agentProviders'
import {
  CUSTOM_AGENT_ID_RE,
  iconFileImportError,
  iconSpecToLegacyKey,
  isValidImageIconUrl,
  legacyIconToSpec,
  normalizeIconSpec,
  sanitizeCustomAgents,
  splitCustomCliCommand,
  toCustomAgentDefinition,
  validateCustomAgent,
  validateIcoBytes,
} from './customAgents'

describe('custom agent id rules', () => {
  it('accepts lowercase slugs between 2 and 32 chars', () => {
    expect(CUSTOM_AGENT_ID_RE.test('my-agent')).toBe(true)
    expect(CUSTOM_AGENT_ID_RE.test('a2')).toBe(true)
    expect(CUSTOM_AGENT_ID_RE.test('A')).toBe(false)
    expect(CUSTOM_AGENT_ID_RE.test('My Agent')).toBe(false)
    expect(CUSTOM_AGENT_ID_RE.test('x')).toBe(false)
  })

  it('rejects built-in ids, duplicates and bad shapes', () => {
    expect(validateCustomAgent({ id: 'claude', label: 'X', cliCommand: 'x' }, [])).toBe('idBuiltin')
    expect(validateCustomAgent({ id: 'Bad Id!', label: 'X', cliCommand: 'x' }, [])).toBe('idFormat')
    expect(
      validateCustomAgent({ id: 'mine', label: 'X', cliCommand: 'x' }, ['mine']),
    ).toBe('idTaken')
    expect(validateCustomAgent({ id: 'mine', label: '  ', cliCommand: 'x' }, [])).toBe(
      'labelEmpty',
    )
    expect(validateCustomAgent({ id: 'mine', label: 'X', cliCommand: '  ' }, [])).toBe('cliEmpty')
  })

  it('rejects shell metacharacters in the cli command', () => {
    expect(validateCustomAgent({ id: 'mine', label: 'X', cliCommand: 'a; rm -rf' }, [])).toBe(
      'cliUnsafe',
    )
    expect(validateCustomAgent({ id: 'mine', label: 'X', cliCommand: 'a | b' }, [])).toBe(
      'cliUnsafe',
    )
    expect(validateCustomAgent({ id: 'mine', label: 'X', cliCommand: 'a $(b)' }, [])).toBe(
      'cliUnsafe',
    )
    expect(
      validateCustomAgent({ id: 'mine', label: 'X', cliCommand: 'my-agent --chat' }, []),
    ).toBeNull()
  })
})

describe('custom cli splitting', () => {
  it('splits the binary from its default args', () => {
    expect(splitCustomCliCommand('my-agent --chat --fast')).toEqual({
      binary: 'my-agent',
      args: ['--chat', '--fast'],
    })
  })

  it('honours quotes and rejects unbalanced input', () => {
    expect(splitCustomCliCommand('my-agent --name "Ada Lovelace"')).toEqual({
      binary: 'my-agent',
      args: ['--name', 'Ada Lovelace'],
    })
    expect(splitCustomCliCommand('my-agent "oops')).toBeNull()
    expect(splitCustomCliCommand('')).toBeNull()
  })
})

describe('custom agent sanitizing', () => {
  it('drops invalid entries and caps the list', () => {
    const cleaned = sanitizeCustomAgents([
      { id: 'good', label: 'Good', cliCommand: 'good --x' },
      { id: 'claude', label: 'Clash', cliCommand: 'claude' },
      { id: 'bad!', label: 'Bad', cliCommand: 'bad' },
      { id: 'good', label: 'Dupe', cliCommand: 'good' },
    ])
    expect(cleaned.map((item) => item.id)).toEqual(['good'])
  })

  it('normalizes ids, flags, accents and icons', () => {
    const definition = toCustomAgentDefinition({
      id: ' My-Agent ',
      label: ' Mine ',
      cliCommand: 'mine --chat',
      unrestrictedFlag: ' --allow-all ',
      accentToken: '--agent-codex',
      icon: 'codex',
    })
    expect(definition.id).toBe('my-agent')
    expect(definition.label).toBe('Mine')
    expect(definition.unrestrictedFlag).toBe('--allow-all')
    expect(definition.accentToken).toBe('--agent-codex')
    expect(definition.icon).toBe('codex')
  })
})

describe('custom agent icon url allowlist', () => {
  it('accepts https png/jpg/jpeg links and rejects everything else', () => {
    expect(isValidImageIconUrl('https://example.com/icon.png')).toBe(true)
    expect(isValidImageIconUrl('https://example.com/a/b/icon.png')).toBe(true)
    expect(isValidImageIconUrl('https://example.com/icon.jpg')).toBe(true)
    expect(isValidImageIconUrl('https://example.com/icon.jpeg')).toBe(true)
    expect(isValidImageIconUrl('https://example.com/ICON.JPG')).toBe(true)
    expect(isValidImageIconUrl('https://example.com/icon.png?size=64')).toBe(true)
    expect(isValidImageIconUrl('http://example.com/icon.png')).toBe(false)
    expect(isValidImageIconUrl('http://example.com/icon.jpg')).toBe(false)
    expect(isValidImageIconUrl('data:image/png;base64,iVBOR')).toBe(false)
    expect(isValidImageIconUrl('javascript:alert(1)')).toBe(false)
    expect(isValidImageIconUrl('blob:https://example.com/123')).toBe(false)
    expect(isValidImageIconUrl('https://example.com/icon.gif')).toBe(false)
    expect(isValidImageIconUrl('https://example.com/icon.webp')).toBe(false)
    expect(isValidImageIconUrl('https://user:pass@example.com/icon.png')).toBe(false)
    expect(isValidImageIconUrl('')).toBe(false)
    expect(isValidImageIconUrl(`https://example.com/${'a'.repeat(600)}.png`)).toBe(false)
  })

  it('maps backend icon-import failures to specific errors', () => {
    expect(iconFileImportError('icon exceeds 512KB')).toBe('iconFileTooLarge')
    expect(iconFileImportError('icon must be square')).toBe('iconFileNotSquare')
    expect(iconFileImportError('not a valid .ico file')).toBe('iconFileInvalid')
    expect(iconFileImportError('only .ico files are accepted')).toBe('iconFileInvalid')
    expect(iconFileImportError('boom')).toBe('iconFile')
    expect(iconFileImportError(null)).toBe('iconFile')
  })

  it('surfaces iconUrl validation errors on save', () => {
    expect(
      validateCustomAgent(
        { id: 'mine', label: 'X', cliCommand: 'x', iconSpec: { kind: 'url', href: 'http://x/icon.png' } },
        [],
      ),
    ).toBe('iconUrl')
    expect(
      validateCustomAgent(
        { id: 'mine', label: 'X', cliCommand: 'x', iconSpec: { kind: 'url', href: 'https://x/icon.png' } },
        [],
      ),
    ).toBeNull()
  })
})

describe('custom agent ico bytes', () => {
  it('accepts the ico magic header and rejects the rest', () => {
    expect(validateIcoBytes(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toBe('ok')
    expect(validateIcoBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('badMagic')
    expect(validateIcoBytes(new Uint8Array([0x00, 0x00]))).toBe('badMagic')
  })

  it('rejects files larger than 512KB', () => {
    const oversized = new Uint8Array(512 * 1024 + 1)
    oversized[0] = 0x00
    oversized[1] = 0x00
    oversized[2] = 0x01
    oversized[3] = 0x00
    expect(validateIcoBytes(oversized)).toBe('tooLarge')
  })

  it('surfaces iconFile validation errors on save', () => {
    expect(
      validateCustomAgent(
        { id: 'mine', label: 'X', cliCommand: 'x', iconSpec: { kind: 'file', assetId: 'bad id!' } },
        [],
      ),
    ).toBe('iconFile')
    expect(
      validateCustomAgent(
        { id: 'mine', label: 'X', cliCommand: 'x', iconSpec: { kind: 'file', assetId: 'mine' } },
        [],
      ),
    ).toBeNull()
  })
})

describe('custom agent icon migration', () => {
  it('maps legacy icon keys to the preset spec with a bot fallback', () => {
    expect(legacyIconToSpec('codex')).toEqual({ kind: 'preset', key: 'codex' })
    expect(legacyIconToSpec('unknown')).toEqual({ kind: 'preset', key: 'bot' })
    expect(legacyIconToSpec(undefined)).toEqual({ kind: 'preset', key: 'bot' })
    expect(iconSpecToLegacyKey({ kind: 'preset', key: 'codex' })).toBe('codex')
    expect(iconSpecToLegacyKey({ kind: 'file', assetId: 'mine' })).toBe('bot')
    expect(iconSpecToLegacyKey({ kind: 'url', href: 'https://x/icon.png' })).toBe('bot')
    expect(iconSpecToLegacyKey(undefined)).toBe('bot')
  })

  it('normalizes stored specs without dropping the agent', () => {
    expect(normalizeIconSpec(undefined, 'codex')).toEqual({ kind: 'preset', key: 'codex' })
    expect(normalizeIconSpec({ kind: 'preset', key: 'nope' }, undefined)).toEqual({
      kind: 'preset',
      key: 'bot',
    })
    expect(normalizeIconSpec({ kind: 'file', assetId: 'Mine' }, undefined)).toEqual({
      kind: 'file',
      assetId: 'mine',
    })
    expect(normalizeIconSpec({ kind: 'file', assetId: 'bad id!' }, undefined)).toEqual({
      kind: 'preset',
      key: 'bot',
    })
    expect(
      normalizeIconSpec({ kind: 'url', href: 'https://x/icon.png' }, undefined),
    ).toEqual({ kind: 'url', href: 'https://x/icon.png' })
    expect(normalizeIconSpec({ kind: 'url', href: 'http://x/icon.png' }, undefined)).toEqual(
      { kind: 'preset', key: 'bot' },
    )
  })

  it('keeps agents with stale icon references and falls back to bot', () => {
    const cleaned = sanitizeCustomAgents([
      { id: 'link', label: 'Link', cliCommand: 'link', iconSpec: { kind: 'url', href: 'http://x/icon.png' } },
      { id: 'file', label: 'File', cliCommand: 'file', iconSpec: { kind: 'file', assetId: 'bad id!' } },
    ])
    expect(cleaned.map((item) => item.id)).toEqual(['link', 'file'])
    expect(cleaned[0].icon).toBe('bot')
    expect(cleaned[0].iconSpec).toEqual({ kind: 'preset', key: 'bot' })
  })
})

describe('custom agent provider sync', () => {
  it('exposes customs through the existing resolvers and removes them on sync', () => {
    syncCustomAgentProviders([
      {
        id: 'my-agent',
        label: 'My Agent',
        cliCommand: 'my-agent --chat',
        unrestrictedFlag: '--allow-all',
        accentToken: '--agent-codex',
        icon: 'bot',
      },
    ])
    try {
      expect(isKnownAgentType('my-agent')).toBe(true)
      expect(allAgentTypes()).toContain('my-agent')
      expect(agentLabel('my-agent')).toBe('My Agent')
      expect(resolveAgentCliCommand('my-agent')).toBe('my-agent')
      expect(resolveCustomAgentArgs('my-agent')).toEqual(['--chat'])
      expect(resolveUnrestrictedFlag('my-agent')).toBe('--allow-all')
    } finally {
      syncCustomAgentProviders([])
    }
    expect(isKnownAgentType('my-agent')).toBe(false)
    expect(allAgentTypes()).not.toContain('my-agent')
    expect(resolveAgentCliCommand('my-agent')).toBeUndefined()
  })

  it('never registers a built-in id as custom', () => {
    syncCustomAgentProviders([
      { id: 'claude', label: 'Fake', cliCommand: 'fake', icon: 'bot' },
    ])
    try {
      expect(agentLabel('claude')).toBe('Claude Code')
      expect(resolveAgentCliCommand('claude')).toBe('claude')
    } finally {
      syncCustomAgentProviders([])
    }
  })
})

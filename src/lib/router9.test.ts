import { describe, expect, it } from 'vitest'

import {
  normalizePort,
  router9BaseUrl,
  router9EnvFor,
  router9HasInstall,
  router9ResolveSource,
  router9SupportsAgent,
} from './router9'
import { DEFAULT_ROUTER9_PREFERENCES, type Router9Preferences } from './types'

const active: Router9Preferences = {
  ...DEFAULT_ROUTER9_PREFERENCES,
  enabled: true,
  apiKey: '9r_test',
}

describe('router9SupportsAgent', () => {
  it('accepts the agents whose CLI reads a base URL from the environment', () => {
    expect(router9SupportsAgent('claude')).toBe(true)
    expect(router9SupportsAgent('codex')).toBe(true)
    expect(router9SupportsAgent('opencode')).toBe(true)
  })

  it('rejects shells and agents without a documented override', () => {
    expect(router9SupportsAgent('shell')).toBe(false)
    expect(router9SupportsAgent('copilot')).toBe(false)
    expect(router9SupportsAgent('kiro')).toBe(false)
  })
})

describe('router9EnvFor', () => {
  it('uses the Anthropic dialect for claude', () => {
    expect(router9EnvFor('claude', active)).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128',
      ANTHROPIC_AUTH_TOKEN: '9r_test',
    })
  })

  it('uses the OpenAI dialect, with the /v1 suffix, for codex and opencode', () => {
    const expected = {
      OPENAI_BASE_URL: 'http://127.0.0.1:20128/v1',
      OPENAI_API_KEY: '9r_test',
    }
    expect(router9EnvFor('codex', active)).toEqual(expected)
    expect(router9EnvFor('opencode', active)).toEqual(expected)
  })

  it('honours a custom port', () => {
    expect(router9EnvFor('claude', { ...active, port: 31000 }).ANTHROPIC_BASE_URL).toBe(
      'http://127.0.0.1:31000',
    )
  })

  it('routes nothing when disabled, unconfigured, or unsupported', () => {
    expect(router9EnvFor('claude', { ...active, enabled: false })).toEqual({})
    expect(router9EnvFor('claude', { ...active, apiKey: '   ' })).toEqual({})
    expect(router9EnvFor('claude', undefined)).toEqual({})
    expect(router9EnvFor('shell', active)).toEqual({})
  })
})

describe('normalizePort', () => {
  it('falls back to the default for values a listener cannot bind', () => {
    expect(normalizePort(0)).toBe(20128)
    expect(normalizePort(70000)).toBe(20128)
    expect(normalizePort(1.5)).toBe(20128)
    expect(normalizePort(3000)).toBe(3000)
  })

  it('keeps router9BaseUrl on loopback', () => {
    expect(router9BaseUrl(0)).toBe('http://127.0.0.1:20128')
  })
})

const emptyInstall = { installed: false, version: null, path: null }

function statusWith(managed: boolean, external: boolean) {
  return {
    managed: managed ? { installed: true, version: '0.5.59', path: null } : emptyInstall,
    external: external ? { installed: true, version: '0.5.40', path: 'C:/bin/9router' } : emptyInstall,
    running: false,
    portInUse: false,
    port: 20128,
    installDir: '',
    dataDir: '',
    logPath: '',
    dashboardUrl: '',
    pinnedVersion: '0.5.59',
  }
}

describe('router9ResolveSource', () => {
  it('prefers the chosen source when it is installed', () => {
    expect(router9ResolveSource(statusWith(true, true), 'external')?.source).toBe('external')
    expect(router9ResolveSource(statusWith(true, true), 'managed')?.source).toBe('managed')
  })

  it('falls back to the other install rather than refusing to start', () => {
    expect(router9ResolveSource(statusWith(true, false), 'external')?.source).toBe('managed')
    expect(router9ResolveSource(statusWith(false, true), 'managed')?.source).toBe('external')
  })

  it('returns null when nothing is installed', () => {
    expect(router9ResolveSource(statusWith(false, false), 'managed')).toBeNull()
    expect(router9ResolveSource(null, 'managed')).toBeNull()
  })
})

describe('router9HasInstall', () => {
  it('is true when either install exists', () => {
    expect(router9HasInstall(statusWith(false, true))).toBe(true)
    expect(router9HasInstall(statusWith(true, false))).toBe(true)
    expect(router9HasInstall(statusWith(false, false))).toBe(false)
    expect(router9HasInstall(null)).toBe(false)
  })
})

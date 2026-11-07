import { describe, expect, it } from 'vitest'

import {
  normalizePort,
  normalizeRemoteUrl,
  normalizeRouter9Models,
  router9ArgsFor,
  router9BaseUrl,
  router9EnvFor,
  router9HasInstall,
  router9KeyEnvFor,
  router9RemoteChecks,
  router9RemoteUrlAllowed,
  router9ResolveSource,
  router9RoutingReady,
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

const remote: Router9Preferences = {
  ...DEFAULT_ROUTER9_PREFERENCES,
  enabled: true,
  mode: 'remote',
  remoteUrl: 'https://gw.example.com',
  models: {
    opus: 'cc/claude-opus-5-5',
    sonnet: 'cc/claude-sonnet-5-5',
    haiku: 'cc/claude-haiku-5-5',
    codex: 'cx/gpt-6.1-sol',
  },
}

describe('router9EnvFor in remote mode', () => {
  it('points claude at the gateway with the mapped models and never carries the key', () => {
    expect(router9EnvFor('claude', remote)).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_MODEL: 'cc/claude-opus-5-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/claude-opus-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'cc/claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'cc/claude-haiku-5-5',
    })
  })

  it('leaves the agent model defaults alone when no model is mapped', () => {
    const bare = { ...remote, models: DEFAULT_ROUTER9_PREFERENCES.models }
    expect(router9EnvFor('claude', bare)).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.example.com' })
  })

  it('gives codex nothing through env: its provider comes in as arguments', () => {
    expect(router9EnvFor('codex', remote)).toEqual({})
  })

  it('ignores a key typed for local mode', () => {
    expect(router9EnvFor('claude', { ...remote, apiKey: '9r_local' })).not.toHaveProperty(
      'ANTHROPIC_AUTH_TOKEN',
    )
  })

  it('routes nothing without a gateway URL', () => {
    expect(router9EnvFor('claude', { ...remote, remoteUrl: '' })).toEqual({})
  })
})

describe('router9KeyEnvFor', () => {
  it('names the env var each agent reads the gateway key from', () => {
    expect(router9KeyEnvFor('claude', remote)).toEqual(['ANTHROPIC_AUTH_TOKEN'])
    expect(router9KeyEnvFor('codex', remote)).toEqual(['ALETHE_ROUTER9_KEY'])
    expect(router9KeyEnvFor('opencode', remote)).toEqual(['OPENAI_API_KEY'])
  })

  it('asks for no key in local mode, when off, without a usable URL, or for shells', () => {
    expect(router9KeyEnvFor('claude', active)).toEqual([])
    expect(router9KeyEnvFor('claude', { ...remote, enabled: false })).toEqual([])
    expect(router9KeyEnvFor('claude', { ...remote, remoteUrl: 'http://gw.example.com' })).toEqual(
      [],
    )
    expect(router9KeyEnvFor('shell', remote)).toEqual([])
    expect(router9KeyEnvFor('claude', undefined)).toEqual([])
  })
})

describe('router9ArgsFor', () => {
  it('declares the gateway as a Codex provider and selects its model', () => {
    expect(router9ArgsFor('codex', remote)).toEqual([
      '-c',
      'model_provider="alethe_router9"',
      '-c',
      'model_providers.alethe_router9.name="9router"',
      '-c',
      'model_providers.alethe_router9.base_url="https://gw.example.com/v1"',
      '-c',
      'model_providers.alethe_router9.env_key="ALETHE_ROUTER9_KEY"',
      '-c',
      'model_providers.alethe_router9.wire_api="responses"',
      '-c',
      'model="cx/gpt-6.1-sol"',
    ])
  })

  it('adds nothing for other agents, local mode, or routing turned off', () => {
    expect(router9ArgsFor('claude', remote)).toEqual([])
    expect(router9ArgsFor('codex', { ...remote, mode: 'local' })).toEqual([])
    expect(router9ArgsFor('codex', { ...remote, enabled: false })).toEqual([])
    expect(router9ArgsFor('codex', { ...remote, remoteUrl: '' })).toEqual([])
  })
})

describe('router9RoutingReady', () => {
  it('needs a running-capable local install and a key in local mode', () => {
    expect(router9RoutingReady(active, 'claude', true)).toBe(true)
    expect(router9RoutingReady(active, 'claude', false)).toBe(false)
    expect(router9RoutingReady({ ...active, apiKey: '' }, 'claude', true)).toBe(false)
  })

  it('needs a URL and a saved key in remote mode, with no local install', () => {
    expect(router9RoutingReady(remote, 'codex', false, true)).toBe(true)
    expect(router9RoutingReady(remote, 'claude', false, false)).toBe(false)
    expect(router9RoutingReady({ ...remote, apiKey: '9r_local' }, 'claude', false, false)).toBe(
      false,
    )
    expect(router9RoutingReady({ ...remote, remoteUrl: '' }, 'claude', false, true)).toBe(false)
    expect(router9RoutingReady(remote, 'shell', false, true)).toBe(false)
  })
})

describe('router9RemoteUrlAllowed', () => {
  it('accepts https anywhere and plain http only on loopback', () => {
    expect(router9RemoteUrlAllowed('https://gw.example.com')).toBe(true)
    expect(router9RemoteUrlAllowed('http://localhost:20128')).toBe(true)
    expect(router9RemoteUrlAllowed('http://127.0.0.1:20128')).toBe(true)
  })

  it('refuses cleartext to remote hosts and values that are not URLs', () => {
    expect(router9RemoteUrlAllowed('http://gw.example.com')).toBe(false)
    expect(router9RemoteUrlAllowed('gw.example.com')).toBe(false)
    expect(router9RemoteUrlAllowed('')).toBe(false)
  })

  it('keeps routing off for a URL it refuses', () => {
    const cleartext = { ...remote, remoteUrl: 'http://gw.example.com' }
    expect(router9RoutingReady(cleartext, 'claude', false, true)).toBe(false)
    expect(router9EnvFor('claude', cleartext)).toEqual({})
    expect(router9ArgsFor('codex', cleartext)).toEqual([])
  })
})

describe('router9RemoteChecks', () => {
  it('reports each part of a complete remote setup as ready', () => {
    expect(router9RemoteChecks(remote, true)).toEqual({ url: 'ok', key: 'saved', models: 4 })
  })

  it('names what is missing or refused', () => {
    expect(
      router9RemoteChecks(
        { ...remote, remoteUrl: '', models: DEFAULT_ROUTER9_PREFERENCES.models },
        false,
      ),
    ).toEqual({ url: 'missing', key: 'missing', models: 0 })
    expect(router9RemoteChecks({ ...remote, remoteUrl: 'http://gw.example.com' }, true)).toEqual({
      url: 'invalid',
      key: 'saved',
      models: 4,
    })
  })
})

describe('normalizeRemoteUrl', () => {
  it('trims the URL down to the gateway base', () => {
    expect(normalizeRemoteUrl(' https://gw.example.com/ ')).toBe('https://gw.example.com')
    expect(normalizeRemoteUrl('https://gw.example.com/v1/')).toBe('https://gw.example.com')
    expect(normalizeRemoteUrl('')).toBe('')
  })
})

describe('normalizeRouter9Models', () => {
  it('keeps trimmed strings and drops anything else', () => {
    expect(normalizeRouter9Models({ opus: ' a ', sonnet: 3, codex: 'c' })).toEqual({
      opus: 'a',
      sonnet: '',
      haiku: '',
      codex: 'c',
    })
    expect(normalizeRouter9Models(undefined)).toEqual(DEFAULT_ROUTER9_PREFERENCES.models)
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
    external: external
      ? { installed: true, version: '0.5.40', path: 'C:/bin/9router' }
      : emptyInstall,
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

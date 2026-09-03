import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PluginManifest } from '../tauri'
import type { PluginContext, PluginModule, ThemeContribution } from './types'

const bundled: { manifest: PluginManifest; load: () => Promise<PluginModule> }[] = []

vi.mock('../../plugins', () => ({
  get BUNDLED_PLUGINS() {
    return bundled
  },
}))

const invokeMock = vi.fn(async () => 'ok')

const registeredMessages: Record<string, string> = {}
vi.mock('../i18n', () => ({
  getLocale: () => 'en',
  registerMessages: (_locale: string, messages: Record<string, string>) => {
    Object.assign(registeredMessages, messages)
    return () => {
      for (const key of Object.keys(messages)) delete registeredMessages[key]
    }
  },
  translateDynamic: (_locale: string, key: string) => registeredMessages[key] ?? key,
}))

const disabledIds: string[] = []
const setEnabledMock = vi.fn(async () => {})
vi.mock('../tauri', () => ({
  pluginsDisabled: async () => disabledIds,
  pluginsList: async () => [],
  pluginSetEnabled: (id: string, enabled: boolean) => setEnabledMock(id, enabled),
  pluginInvoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}))

const { getPluginEntries, initPluginHost, resetPluginHostForTests, setPluginEnabled } =
  await import('./host')
const { commandContributions, paneContributions, sidebarTabContributions, themeContributions } =
  await import('./registry')

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test.plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    kind: 'ui',
    apiVersion: 1,
    description: '',
    capabilities: [],
    spec: {},
    ...overrides,
  }
}

const theme: ThemeContribution = {
  id: 'test-theme',
  label: 'Test',
  swatch: ['#000000', '#ffffff', '#ffffff'],
  tokens: { '--bg': '#000000' },
}

function entryFor(id: string) {
  return getPluginEntries().find((e) => e.manifest.id === id)
}

beforeEach(() => {
  bundled.length = 0
  disabledIds.length = 0
  invokeMock.mockClear()
  setEnabledMock.mockClear()
  for (const key of Object.keys(registeredMessages)) delete registeredMessages[key]
})

afterEach(async () => {
  await resetPluginHostForTests()
})

describe('initPluginHost', () => {
  it('activates enabled bundled plugins and applies their contributions', async () => {
    const activate = vi.fn((ctx: PluginContext) => {
      ctx.contributes.theme(theme)
    })
    bundled.push({
      manifest: manifest({ capabilities: ['ui.theme'] }),
      load: async () => ({ activate }),
    })

    await initPluginHost()

    expect(activate).toHaveBeenCalledTimes(1)
    expect(entryFor('test.plugin')).toMatchObject({ active: true, enabled: true, error: null })
    expect(themeContributions.get('test-theme')).toBeDefined()
  })

  it('does not load a disabled plugin', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }))
    bundled.push({ manifest: manifest(), load })
    disabledIds.push('test.plugin')

    await initPluginHost()

    expect(load).not.toHaveBeenCalled()
    expect(entryFor('test.plugin')).toMatchObject({ active: false, enabled: false })
  })

  it('refuses a manifest built for another api version', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }))
    bundled.push({ manifest: manifest({ apiVersion: 2 }), load })

    await initPluginHost()

    expect(load).not.toHaveBeenCalled()
    expect(entryFor('test.plugin')?.error).toBe('unsupported_api_version:2')
  })

  it('refuses a manifest with a blanket capability', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['*'] }),
      load: async () => ({ activate: vi.fn() }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('invalid_capability:*')
  })

  it('records an activation failure and leaves no partial contribution behind', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.theme'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.theme(theme)
          throw new Error('boom')
        },
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')).toMatchObject({ active: false, error: 'boom' })
    expect(themeContributions.get('test-theme')).toBeUndefined()
  })

  it('denies a contribution the manifest did not ask for', async () => {
    bundled.push({
      manifest: manifest({ capabilities: [] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.theme(theme)
        },
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('capability_denied:test.plugin:ui.theme')
    expect(themeContributions.get('test-theme')).toBeUndefined()
  })
})

describe('ui contributions', () => {
  function Dummy() {
    return null
  }

  it('registers panes and sidebar tabs when the manifest allows it', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.pane', 'ui.sidebarTab'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.pane({ id: 'test-pane', component: Dummy })
          ctx.contributes.sidebarTab({
            id: 'test-tab',
            side: 'right',
            icon: Dummy,
            label: 'Test',
            component: Dummy,
          })
        },
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBeNull()
    expect(paneContributions.get('test-pane')).toBeDefined()
    expect(sidebarTabContributions.get('test-tab')?.side).toBe('right')
  })

  it('registers a command and runs it', async () => {
    const run = vi.fn()
    bundled.push({
      manifest: manifest({ capabilities: ['ui.command'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.command({ id: 'test.cmd', label: 'Test Command', run })
        },
      }),
    })

    await initPluginHost()

    const command = commandContributions.get('test.cmd')
    expect(command?.label).toBe('Test Command')
    command?.run()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('denies a command the manifest did not ask for', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.pane'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.command({ id: 'test.cmd', label: 'Test', run: vi.fn() })
        },
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('capability_denied:test.plugin:ui.command')
    expect(commandContributions.get('test.cmd')).toBeUndefined()
  })

  it('denies a pane when only the theme capability is declared', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.theme'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.pane({ id: 'test-pane', component: Dummy })
        },
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('capability_denied:test.plugin:ui.pane')
    expect(paneContributions.get('test-pane')).toBeUndefined()
  })

  it('drops both contributions when the plugin is disabled', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.pane', 'ui.sidebarTab'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.pane({ id: 'test-pane', component: Dummy })
          ctx.contributes.sidebarTab({
            id: 'test-tab',
            side: 'left',
            icon: Dummy,
            label: 'Test',
            component: Dummy,
          })
        },
      }),
    })

    await initPluginHost()
    await setPluginEnabled('test.plugin', false)

    expect(paneContributions.get('test-pane')).toBeUndefined()
    expect(sidebarTabContributions.get('test-tab')).toBeUndefined()
  })

  it('drops a command when the plugin is disabled', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.command'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.command({ id: 'test.cmd', label: 'Test', run: vi.fn() })
        },
      }),
    })

    await initPluginHost()
    expect(commandContributions.get('test.cmd')).toBeDefined()

    await setPluginEnabled('test.plugin', false)
    expect(commandContributions.get('test.cmd')).toBeUndefined()
  })
})

describe('plugin context', () => {
  it('namespaces registered messages and resolves them through t()', async () => {
    let captured: PluginContext | null = null
    bundled.push({
      manifest: manifest(),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          captured = ctx
          ctx.registerMessages('en', { title: 'Hello' })
        },
      }),
    })

    await initPluginHost()

    expect(registeredMessages['plugin.test.plugin.title']).toBe('Hello')
    expect(captured!.t('title')).toBe('Hello')
    // An already-prefixed key is not prefixed twice.
    expect(captured!.t('plugin.test.plugin.title')).toBe('Hello')
  })

  it('gates invoke on the declared capabilities', async () => {
    let captured: PluginContext | null = null
    bundled.push({
      manifest: manifest({ capabilities: ['invoke:git_*'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          captured = ctx
        },
      }),
    })

    await initPluginHost()

    await expect(captured!.invoke('git_status', { cwd: '.' })).resolves.toBe('ok')
    expect(invokeMock).toHaveBeenCalledWith('git_status', { cwd: '.' })

    await expect(captured!.invoke('worktree_list')).rejects.toThrow(
      'capability_denied:test.plugin:invoke:worktree_list',
    )
    await expect(captured!.invoke('spawn_pty')).rejects.toThrow('capability_denied')
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})

describe('setPluginEnabled', () => {
  it('tears contributions down on disable and brings them back on enable', async () => {
    const deactivate = vi.fn()
    bundled.push({
      manifest: manifest({ capabilities: ['ui.theme'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.theme(theme)
          ctx.registerMessages('en', { title: 'Hello' })
        },
        deactivate,
      }),
    })

    await initPluginHost()
    expect(themeContributions.get('test-theme')).toBeDefined()

    await setPluginEnabled('test.plugin', false)
    expect(setEnabledMock).toHaveBeenCalledWith('test.plugin', false)
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(themeContributions.get('test-theme')).toBeUndefined()
    expect(registeredMessages['plugin.test.plugin.title']).toBeUndefined()
    expect(entryFor('test.plugin')).toMatchObject({ enabled: false, active: false })

    await setPluginEnabled('test.plugin', true)
    expect(themeContributions.get('test-theme')).toBeDefined()
    expect(registeredMessages['plugin.test.plugin.title']).toBe('Hello')
    expect(entryFor('test.plugin')).toMatchObject({ enabled: true, active: true })
  })

  it('rolls the flag back when persistence fails', async () => {
    bundled.push({ manifest: manifest(), load: async () => ({ activate: vi.fn() }) })
    await initPluginHost()

    setEnabledMock.mockRejectedValueOnce(new Error('disk_full'))
    await setPluginEnabled('test.plugin', false)

    expect(entryFor('test.plugin')).toMatchObject({ enabled: true, active: true })
    expect(entryFor('test.plugin')?.error).toBe('disk_full')
  })
})

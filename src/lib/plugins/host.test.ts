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

const {
  activateForView,
  ensureActivated,
  getPluginEntries,
  initPluginHost,
  resetPluginHostForTests,
  runCommand,
  setPluginEnabled,
} = await import('./host')
const { commandContributions, paneContributions, sidebarTabContributions, themeContributions } =
  await import('./registry')
const { agentProviderContributions } = await import('../agentProviders')

function Dummy() {
  return null
}

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

/** A manifest that declares one view and one command, with the capabilities for both. */
function declaringManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return manifest({
    capabilities: ['ui.sidebarTab', 'ui.command'],
    activation: ['onView:test.view', 'onCommand:test.cmd'],
    contributes: {
      views: [
        { id: 'test.view', container: 'rightSidebar', title: 'Test View', icon: 'puzzle' },
      ],
      commands: [{ id: 'test.cmd', title: 'Test Command' }],
    },
    ...overrides,
  })
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

describe('declared contributions', () => {
  it('registers manifest views and commands without loading the plugin', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }))
    bundled.push({ manifest: declaringManifest(), load })

    await initPluginHost()

    expect(load).not.toHaveBeenCalled()
    expect(entryFor('test.plugin')).toMatchObject({ active: false, enabled: true, error: null })

    const view = sidebarTabContributions.get('test.view')
    expect(view).toMatchObject({ pluginId: 'test.plugin', side: 'right', label: 'Test View' })
    expect(view?.component).toBeNull()
    expect(commandContributions.get('test.cmd')?.label).toBe('Test Command')
  })

  it('activates on demand when the view is revealed and fills the implementation in', async () => {
    bundled.push({
      manifest: declaringManifest(),
      load: async () => ({
        activate: (ctx: PluginContext) => ctx.registerView('test.view', Dummy),
      }),
    })

    await initPluginHost()
    expect(sidebarTabContributions.get('test.view')?.component).toBeNull()

    await activateForView('test.view')

    expect(entryFor('test.plugin')?.active).toBe(true)
    expect(sidebarTabContributions.get('test.view')?.component).toBe(Dummy)
  })

  it('activates on demand when a command runs, then runs the handler', async () => {
    const handler = vi.fn()
    bundled.push({
      manifest: declaringManifest(),
      load: async () => ({
        activate: (ctx: PluginContext) => ctx.registerCommand('test.cmd', handler),
      }),
    })

    await initPluginHost()
    expect(handler).not.toHaveBeenCalled()

    await commandContributions.get('test.cmd')!.run()

    expect(entryFor('test.plugin')?.active).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent activation into a single load', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }))
    bundled.push({ manifest: declaringManifest(), load })

    await initPluginHost()
    await Promise.all([
      ensureActivated('test.plugin'),
      ensureActivated('test.plugin'),
      activateForView('test.view'),
      runCommand('test.cmd'),
    ])

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('activates at startup when the manifest asks for it', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }))
    bundled.push({ manifest: manifest({ activation: ['onStartupFinished'] }), load })

    await initPluginHost()

    expect(load).toHaveBeenCalledTimes(1)
    expect(entryFor('test.plugin')?.active).toBe(true)
  })

  it('treats an empty activation list as startup activation', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }))
    bundled.push({ manifest: manifest(), load })

    await initPluginHost()

    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('manifest validation', () => {
  it('refuses declared views without the matching capability', async () => {
    bundled.push({
      manifest: declaringManifest({ capabilities: ['ui.command'] }),
      load: async () => ({ activate: vi.fn() }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('capability_denied:test.plugin:ui.sidebarTab')
    expect(sidebarTabContributions.get('test.view')).toBeUndefined()
    expect(commandContributions.get('test.cmd')).toBeUndefined()
  })

  it('refuses an activation event pointing at nothing', async () => {
    bundled.push({
      manifest: declaringManifest({ activation: ['onView:missing'] }),
      load: async () => ({ activate: vi.fn() }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('unknown_activation_target:onView:missing')
  })

  it('refuses an activation event it does not understand', async () => {
    bundled.push({
      manifest: declaringManifest({ activation: ['*'] }),
      load: async () => ({ activate: vi.fn() }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('unknown_activation_event:*')
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

  it('refuses to implement a view the manifest never declared', async () => {
    bundled.push({
      manifest: declaringManifest(),
      load: async () => ({
        activate: (ctx: PluginContext) => ctx.registerView('not.declared', Dummy),
      }),
    })

    await initPluginHost()
    await activateForView('test.view')

    expect(entryFor('test.plugin')?.error).toBe('undeclared_view:test.plugin:not.declared')
    expect(sidebarTabContributions.get('test.view')?.component).toBeNull()
  })

  it('refuses to reveal a view the plugin does not own', async () => {
    // The navigation surface exists so a local plugin can open its own tab. It must not become a
    // way to drive someone else's: a plugin steering another's UI is worse than not steering at all.
    bundled.push({
      manifest: declaringManifest(),
      load: async () => ({
        activate: (ctx: PluginContext) => ctx.ui.revealView('someone.elses.view'),
      }),
    })

    await initPluginHost()
    await activateForView('test.view')

    expect(entryFor('test.plugin')?.error).toBe('undeclared_view:test.plugin:someone.elses.view')
  })

  it('refuses to open a modal the plugin never contributed', async () => {
    bundled.push({
      manifest: declaringManifest(),
      load: async () => ({
        activate: (ctx: PluginContext) => ctx.ui.openModal('preferences'),
      }),
    })

    await initPluginHost()
    await activateForView('test.view')

    expect(entryFor('test.plugin')?.error).toBe('undeclared_modal:test.plugin:preferences')
  })
})

describe('imperative contributions', () => {
  it('registers themes and panes when the manifest allows it', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.theme', 'ui.pane'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.contributes.theme(theme)
          ctx.contributes.pane({ id: 'test-pane', component: Dummy })
        },
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBeNull()
    expect(themeContributions.get('test-theme')).toBeDefined()
    expect(paneContributions.get('test-pane')).toBeDefined()
  })

  it('registers an agent provider when the manifest allows it', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['agent.provider'] }),
      load: async () => ({
        activate: (ctx: PluginContext) =>
          ctx.contributes.agentProvider({ id: 'cursor', label: 'Cursor CLI', cliCommand: 'cursor' }),
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBeNull()
    expect(agentProviderContributions.get('cursor')?.cliCommand).toBe('cursor')

    await setPluginEnabled('test.plugin', false)
    expect(agentProviderContributions.get('cursor')).toBeUndefined()
  })

  it('denies an agent provider the manifest did not ask for', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.theme'] }),
      load: async () => ({
        activate: (ctx: PluginContext) =>
          ctx.contributes.agentProvider({ id: 'cursor', label: 'Cursor CLI' }),
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('capability_denied:test.plugin:agent.provider')
    expect(agentProviderContributions.get('cursor')).toBeUndefined()
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
        activate: (ctx: PluginContext) => ctx.contributes.theme(theme),
      }),
    })

    await initPluginHost()

    expect(entryFor('test.plugin')?.error).toBe('capability_denied:test.plugin:ui.theme')
    expect(themeContributions.get('test-theme')).toBeUndefined()
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
  it('drops declared contributions on disable and brings them back on enable', async () => {
    const deactivate = vi.fn()
    bundled.push({
      manifest: declaringManifest(),
      load: async () => ({
        activate: (ctx: PluginContext) => {
          ctx.registerView('test.view', Dummy)
          ctx.registerCommand('test.cmd', vi.fn())
          ctx.registerMessages('en', { title: 'Hello' })
        },
        deactivate,
      }),
    })

    await initPluginHost()
    await activateForView('test.view')
    expect(sidebarTabContributions.get('test.view')?.component).toBe(Dummy)

    await setPluginEnabled('test.plugin', false)
    expect(setEnabledMock).toHaveBeenCalledWith('test.plugin', false)
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(sidebarTabContributions.get('test.view')).toBeUndefined()
    expect(commandContributions.get('test.cmd')).toBeUndefined()
    expect(registeredMessages['plugin.test.plugin.title']).toBeUndefined()

    await setPluginEnabled('test.plugin', true)
    // The declaration is back; the implementation waits for the next reveal.
    expect(sidebarTabContributions.get('test.view')).toBeDefined()
    expect(entryFor('test.plugin')).toMatchObject({ enabled: true, active: false })

    await activateForView('test.view')
    expect(sidebarTabContributions.get('test.view')?.component).toBe(Dummy)
  })

  it('tears an imperative contribution down on disable', async () => {
    bundled.push({
      manifest: manifest({ capabilities: ['ui.theme'] }),
      load: async () => ({
        activate: (ctx: PluginContext) => ctx.contributes.theme(theme),
      }),
    })

    await initPluginHost()
    expect(themeContributions.get('test-theme')).toBeDefined()

    await setPluginEnabled('test.plugin', false)
    expect(themeContributions.get('test-theme')).toBeUndefined()

    await setPluginEnabled('test.plugin', true)
    expect(themeContributions.get('test-theme')).toBeDefined()
  })

  it('rolls the flag back when persistence fails', async () => {
    bundled.push({ manifest: manifest(), load: async () => ({ activate: vi.fn() }) })
    await initPluginHost()

    setEnabledMock.mockRejectedValueOnce(new Error('disk_full'))
    await setPluginEnabled('test.plugin', false)

    expect(entryFor('test.plugin')).toMatchObject({ enabled: true, active: true })
    expect(entryFor('test.plugin')?.error).toBe('disk_full')
  })

  it('never loads a plugin disabled before startup', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }))
    bundled.push({ manifest: declaringManifest(), load })
    disabledIds.push('test.plugin')

    await initPluginHost()

    expect(load).not.toHaveBeenCalled()
    expect(sidebarTabContributions.get('test.view')).toBeUndefined()
    expect(entryFor('test.plugin')).toMatchObject({ active: false, enabled: false })
  })
})

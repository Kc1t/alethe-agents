import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginManifest } from '../tauri'
import { loadLocalPlugin, pluginAssetUrl, resetLocalTransportForTests } from './localTransport'
import type { PluginModule } from './types'

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'local.demo',
    name: 'Demo',
    version: '1.0.0',
    kind: 'ui',
    apiVersion: 1,
    description: '',
    capabilities: [],
    entry: 'main.js',
    spec: {},
    ...overrides,
  }
}

function injectedScript() {
  return document.head.querySelector<HTMLScriptElement>('script[data-alethe-plugin]')
}

function injectedLink() {
  return document.head.querySelector<HTMLLinkElement>('link[data-alethe-plugin]')
}

afterEach(() => {
  resetLocalTransportForTests()
  for (const node of document.head.querySelectorAll('[data-alethe-plugin]')) node.remove()
  vi.useRealTimers()
})

describe('loadLocalPlugin', () => {
  it('refuses a manifest with no entry', async () => {
    await expect(loadLocalPlugin(manifest({ entry: undefined }))).rejects.toThrow(
      'missing_entry:local.demo',
    )
  })

  it('builds the URL form each platform actually resolves', () => {
    // Windows and Android reach a custom scheme through <scheme>.localhost;
    // getting this wrong means the script silently never loads.
    expect(pluginAssetUrl('local.demo', 'main.js', true)).toBe(
      'http://alethe-plugin.localhost/local.demo/main.js',
    )
    expect(pluginAssetUrl('local.demo', 'main.js', false)).toBe(
      'alethe-plugin://local.demo/main.js',
    )
    expect(pluginAssetUrl('local.demo', 'nested dir/a b.css', true)).toBe(
      'http://alethe-plugin.localhost/local.demo/nested%20dir/a%20b.css',
    )
  })

  it('serves the entry from the plugin scheme and resolves on registration', async () => {
    const module: PluginModule = { activate: vi.fn() }
    const pending = loadLocalPlugin(manifest())

    expect(injectedScript()?.getAttribute('src')).toBe('alethe-plugin://local.demo/main.js')
    expect(window.alethe?.apiVersion).toBe(1)
    expect(window.alethe?.react).toBeDefined()

    window.alethe!.registerPlugin('local.demo', module)
    const loaded = await pending

    expect(loaded.activate).toBe(module.activate)
    // The tag is dropped once the code has run; removing it does not unload it.
    expect(injectedScript()).toBeNull()
  })

  it('encodes each path segment without collapsing the separators', async () => {
    const pending = loadLocalPlugin(manifest({ entry: 'nested dir/main file.js' }))
    expect(injectedScript()?.getAttribute('src')).toBe(
      'alethe-plugin://local.demo/nested%20dir/main%20file.js',
    )
    window.alethe!.registerPlugin('local.demo', {})
    await pending
  })

  it('injects the declared stylesheet and removes it on deactivate', async () => {
    const deactivate = vi.fn()
    const pending = loadLocalPlugin(manifest({ styles: 'styles.css' }))

    expect(injectedLink()?.getAttribute('href')).toBe('alethe-plugin://local.demo/styles.css')

    window.alethe!.registerPlugin('local.demo', { deactivate })
    const loaded = await pending

    await loaded.deactivate?.({} as never)
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(injectedLink()).toBeNull()
  })

  it('removes the stylesheet even when the plugin throws on deactivate', async () => {
    const pending = loadLocalPlugin(manifest({ styles: 'styles.css' }))
    window.alethe!.registerPlugin('local.demo', {
      deactivate: () => {
        throw new Error('boom')
      },
    })
    const loaded = await pending

    await expect(loaded.deactivate?.({} as never)).rejects.toThrow('boom')
    expect(injectedLink()).toBeNull()
  })

  it('gives up when the script never registers, and cleans up after itself', async () => {
    vi.useFakeTimers()
    const pending = loadLocalPlugin(manifest({ styles: 'styles.css' }))
    const settled = expect(pending).rejects.toThrow('plugin_registration_timeout:local.demo')

    await vi.advanceTimersByTimeAsync(10_000)
    await settled

    expect(injectedScript()).toBeNull()
    expect(injectedLink()).toBeNull()
  })

  it('rejects when the script fails to load', async () => {
    const pending = loadLocalPlugin(manifest())
    injectedScript()?.dispatchEvent(new Event('error'))

    await expect(pending).rejects.toThrow('plugin_script_failed:local.demo')
    expect(injectedScript()).toBeNull()
  })

  it('ignores a registration for a plugin nobody is waiting on', async () => {
    const pending = loadLocalPlugin(manifest())
    expect(() => window.alethe!.registerPlugin('someone.else', {})).not.toThrow()

    window.alethe!.registerPlugin('local.demo', {})
    await expect(pending).resolves.toBeDefined()
  })
})

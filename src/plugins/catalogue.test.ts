import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { PLUGIN_API_VERSION } from '../lib/plugins/constants'
import { BUNDLED_PLUGINS } from '.'

type BuiltInListing = {
  id: string
  name: string
  description: string
  version: string
  capabilities: string[]
}

type CatalogueListing = BuiltInListing & {
  downloadUrl: string
  minApiVersion?: number
  package?: { url: string; sha256: string }
}

const catalogue = JSON.parse(readFileSync('plugins.json', 'utf8')) as {
  plugins: CatalogueListing[]
  builtIn: BuiltInListing[]
}

describe('plugins.json', () => {
  it('lists exactly the plugins that ship inside the app', () => {
    expect(catalogue.builtIn).toEqual(
      BUNDLED_PLUGINS.map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        capabilities: manifest.capabilities,
      })),
    )
  })

  it('offers only installable listings this build understands', () => {
    const ids = [...catalogue.plugins, ...catalogue.builtIn].map((plugin) => plugin.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const plugin of catalogue.plugins) {
      expect(plugin.id).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(plugin.downloadUrl.startsWith('https://')).toBe(true)
      expect(plugin.minApiVersion ?? 1).toBeLessThanOrEqual(PLUGIN_API_VERSION)
      if (!plugin.package) continue
      expect(plugin.package.url.startsWith('https://')).toBe(true)
      expect(plugin.package.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

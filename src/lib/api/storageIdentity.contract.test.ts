import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('shared core storage identity configuration', () => {
  it('keeps production and development identifiers explicit and separate', () => {
    const production = readJson('../../../src-tauri/tauri.conf.json')
    const development = readJson('../../../src-tauri/tauri.dev.json')

    expect(production.identifier).toBe('com.kc1t.alethe')
    expect(development.identifier).toBe('com.kc1t.alethe.dev')
  })

  it('starts the attach-first Web launcher with the development identifier', () => {
    const packageJson = readJson('../../../package.json')
    const scripts = packageJson.scripts as Record<string, string>

    expect(scripts.web).toContain('ALETHE_APP_IDENTIFIER=com.kc1t.alethe.dev')
    expect(scripts.web).toContain('VITE_ALETHE_APP_IDENTIFIER=com.kc1t.alethe.dev')
    expect(scripts.web).toContain('node scripts/web-launcher.mjs')
    expect(scripts['web:ui']).toBe('vite --port 1424')
    expect(scripts['web:core']).toContain('--bin alethe-server')
    expect(scripts['web:diagnose']).toContain('scripts/web-launcher.mjs --diagnose')
  })

  it('routes both Vite entry ports to the single loopback authority', () => {
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')

    expect(viteConfig).toContain("ALETHE_SERVER_PORT || '1423'")
    expect(viteConfig).toContain('Number(process.env.ALETHE_DEV_PORT) || 1422')
  })
})

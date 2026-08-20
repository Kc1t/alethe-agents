import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

type TauriConfig = {
  app?: {
    security?: {
      csp?: string | Record<string, string[] | string> | null
      devCsp?: string | Record<string, string[] | string> | null
    }
  }
}

type Capability = {
  webviews?: string[]
  windows?: string[]
  permissions?: string[]
}

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(resolve(relativePath), 'utf8')) as T

const config = readJson<TauriConfig>('src-tauri/tauri.conf.json')
const capability = readJson<Capability>('src-tauri/capabilities/default.json')

function productionDirectives(): Map<string, string[]> {
  const csp = config.app?.security?.csp
  expect(csp, 'production CSP must be explicitly configured').not.toBeNull()
  expect(csp, 'production CSP must be explicitly configured').toBeDefined()

  if (typeof csp === 'string') {
    return new Map(
      csp
        .split(';')
        .map((directive) => directive.trim())
        .filter(Boolean)
        .map((directive) => {
          const [name, ...sources] = directive.split(/\s+/)
          return [name, sources]
        }),
    )
  }

  return new Map(
    Object.entries(csp ?? {}).map(([name, sources]) => [
      name,
      Array.isArray(sources) ? sources : sources.split(/\s+/).filter(Boolean),
    ]),
  )
}

describe('production renderer security policy', () => {
  it('keeps executable code out of index.html', () => {
    const html = readFileSync(resolve('index.html'), 'utf8')
    const document = new DOMParser().parseFromString(html, 'text/html')
    const scripts = [...document.querySelectorAll('script')]

    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts.filter((script) => !script.hasAttribute('src'))).toEqual([])
  })

  it('locks down fallback, object, base, form, and script execution', () => {
    const directives = productionDirectives()

    expect(directives.get('default-src')).toEqual(["'none'"])
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('base-uri')).toEqual(["'none'"])
    expect(directives.get('form-action')).toEqual(["'none'"])
    expect(directives.get('frame-ancestors')).toEqual(["'none'"])
    expect(directives.get('script-src')).toEqual(["'self'"])
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'")
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'")
  })

  it('keeps only the audited runtime source requirements', () => {
    const directives = productionDirectives()

    expect(directives.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(directives.get('img-src')).toEqual([
      "'self'",
      'data:',
      'asset:',
      'http://asset.localhost',
      'http:',
      'https:',
    ])
    expect(directives.get('media-src')).toEqual(["'self'", 'asset:', 'http://asset.localhost'])
    expect(directives.get('font-src')).toEqual(["'self'"])
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      'ipc:',
      'http://ipc.localhost',
      'https://registry.npmjs.org',
      'https://api.github.com',
    ])
    expect(directives.get('worker-src')).toEqual(["'none'"])
    expect(directives.get('frame-src')).toEqual([
      'asset:',
      'http://asset.localhost',
      'http:',
      'https:',
    ])
  })

  it('explicitly leaves the development CSP unset for Vite HMR', () => {
    expect(config.app?.security?.devCsp).toBeNull()
  })

  it('scopes an enumerated capability to the privileged main webview', () => {
    expect(capability.webviews).toEqual(['main'])
    expect(capability.windows).toBeUndefined()
    expect(capability.permissions).toEqual([
      'core:app:allow-version',
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-destroy',
      'core:window:allow-start-dragging',
      'core:window:allow-is-focused',
      'core:window:allow-is-minimized',
      'core:window:allow-set-icon',
      'core:window:allow-set-title',
      'core:webview:allow-create-webview',
      'core:webview:allow-webview-close',
      'core:webview:allow-webview-hide',
      'core:webview:allow-webview-show',
      'core:webview:allow-set-webview-position',
      'core:webview:allow-set-webview-size',
      'core:webview:allow-set-webview-zoom',
      'dialog:allow-open',
      'dialog:allow-save',
      'dialog:allow-confirm',
      'dialog:allow-message',
      'notification:allow-is-permission-granted',
      'notification:allow-request-permission',
      'notification:allow-notify',
      'updater:allow-check',
      'updater:allow-download-and-install',
      'process:allow-restart',
    ])
    expect(capability.permissions).not.toContain('core:default')
    expect(capability.permissions).not.toContain('core:event:allow-emit')
    expect(capability.permissions).not.toContain('core:event:allow-emit-to')
  })
})

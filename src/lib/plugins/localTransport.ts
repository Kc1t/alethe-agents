import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

import type { PluginManifest } from '../tauri'
import { PLUGIN_API_VERSION } from './constants'
import type { PluginModule } from './types'

const LOAD_TIMEOUT_MS = 10_000

/**
 * The stable surface a local plugin binds against. It is string-keyed on
 * purpose: the production bundle is minified with `mangle.toplevel`, so a
 * plugin can never import from the host by module name.
 */
export type AletheGlobal = {
  apiVersion: number
  react: typeof React
  jsxRuntime: typeof jsxRuntime
  registerPlugin: (id: string, module: PluginModule) => void
}

declare global {
  interface Window {
    alethe?: AletheGlobal
  }
}

const pending = new Map<string, (module: PluginModule) => void>()

function installGlobalApi() {
  if (window.alethe) return
  window.alethe = {
    apiVersion: PLUGIN_API_VERSION,
    react: React,
    jsxRuntime,
    registerPlugin: (id, module) => {
      pending.get(id)?.(module)
    },
  }
}

/**
 * Windows and Android reach a custom scheme as `http://<scheme>.localhost`;
 * every other platform uses `<scheme>://`. Getting this wrong fails silently —
 * the script simply never loads.
 */
function usesLocalhostScheme(): boolean {
  return typeof navigator !== 'undefined' && /Windows|Android/i.test(navigator.userAgent)
}

export function pluginAssetUrl(
  pluginId: string,
  file: string,
  localhostScheme: boolean = usesLocalhostScheme(),
): string {
  const path = file.split('/').map(encodeURIComponent).join('/')
  const base = localhostScheme
    ? `http://alethe-plugin.localhost/${pluginId}`
    : `alethe-plugin://${pluginId}`
  return `${base}/${path}`
}

function injectStyles(manifest: PluginManifest): HTMLLinkElement | null {
  if (!manifest.styles) return null
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = pluginAssetUrl(manifest.id, manifest.styles)
  link.dataset.alethePlugin = manifest.id
  document.head.appendChild(link)
  return link
}

/**
 * Loads a local plugin's `entry` through the `alethe-plugin://` scheme, which
 * resolves only inside that plugin's own directory. The script registers itself
 * through `window.alethe`; nothing is evaluated from a string.
 */
export async function loadLocalPlugin(manifest: PluginManifest): Promise<PluginModule> {
  if (!manifest.entry) throw new Error(`missing_entry:${manifest.id}`)
  installGlobalApi()

  const link = injectStyles(manifest)
  const script = document.createElement('script')
  script.src = pluginAssetUrl(manifest.id, manifest.entry)
  script.async = true
  script.dataset.alethePlugin = manifest.id

  let timer: number | undefined
  const cleanUp = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    pending.delete(manifest.id)
    script.remove()
  }

  try {
    const module = await new Promise<PluginModule>((resolve, reject) => {
      pending.set(manifest.id, resolve)
      script.onerror = () => reject(new Error(`plugin_script_failed:${manifest.id}`))
      timer = window.setTimeout(
        () => reject(new Error(`plugin_registration_timeout:${manifest.id}`)),
        LOAD_TIMEOUT_MS,
      )
      document.head.appendChild(script)
    })
    cleanUp()

    return {
      activate: module.activate,
      deactivate: async (context) => {
        try {
          await module.deactivate?.(context)
        } finally {
          link?.remove()
        }
      },
    }
  } catch (error) {
    cleanUp()
    link?.remove()
    throw error
  }
}

/** Test seam. */
export function resetLocalTransportForTests(): void {
  pending.clear()
  delete window.alethe
}

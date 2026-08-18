import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const workflowPath = join(root, '.github/workflows/release.yml')
const wrapperPath = join(root, 'scripts/linuxdeploy-plugin-gtk-wrapper.sh')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('Linux AppImage packaging', () => {
  it('pins and verifies the wrapped GTK plugin only on Linux', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const preparation = workflow.indexOf('Prepare compatible Linux AppImage GTK plugin')
    const packaging = workflow.indexOf('uses: tauri-apps/tauri-action@v0')

    expect(preparation).toBeGreaterThan(-1)
    expect(preparation).toBeLessThan(packaging)
    expect(workflow).toContain("if: matrix.platform == 'ubuntu-22.04'")
    expect(workflow).toMatch(/GTK_PLUGIN_COMMIT: [0-9a-f]{40}/)
    expect(workflow).toMatch(/GTK_PLUGIN_SHA256: [0-9a-f]{64}/)
    expect(workflow).toContain('sha256sum --check')
    expect(workflow).not.toContain('LD_PRELOAD')
    expect(workflow).not.toContain('LINUXDEPLOY_EXCLUDED_LIBRARIES')
  })

  it.skipIf(process.platform === 'win32')(
    'runs the upstream GTK plugin before removing only the Wayland client',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'alethe-appimage-wrapper-'))
      temporaryDirectories.push(directory)
      const pluginDirectory = join(directory, 'plugin')
      const appDirectory = join(directory, 'AppDir')
      const libraryDirectory = join(appDirectory, 'usr/lib')
      mkdirSync(pluginDirectory, { recursive: true })
      mkdirSync(libraryDirectory, { recursive: true })
      cpSync(wrapperPath, join(pluginDirectory, 'linuxdeploy-plugin-gtk.sh'))
      writeFileSync(
        join(pluginDirectory, 'alethe-gtk-upstream.sh'),
        `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "\${1:-}" == '--plugin-api-version' ]]; then printf '0\\n'; exit 0; fi\nappdir=''\nwhile (($#)); do\n  case "$1" in\n    --appdir) appdir=$2; shift 2 ;;\n    --appdir=*) appdir=\${1#--appdir=}; shift ;;\n    *) shift ;;\n  esac\ndone\ntouch "$appdir/usr/lib/libwayland-client.so.0"\ntouch "$appdir/usr/lib/libgtk-3.so.0"\n`,
        { mode: 0o755 },
      )

      expect(
        execFileSync('bash', [
          join(pluginDirectory, 'linuxdeploy-plugin-gtk.sh'),
          '--plugin-api-version',
        ]).toString(),
      ).toBe('0\n')

      execFileSync('bash', [
        join(pluginDirectory, 'linuxdeploy-plugin-gtk.sh'),
        '--appdir',
        appDirectory,
      ])

      expect(() => readFileSync(join(libraryDirectory, 'libwayland-client.so.0'))).toThrow()
      expect(readFileSync(join(libraryDirectory, 'libgtk-3.so.0'))).toHaveLength(0)
    },
  )
})

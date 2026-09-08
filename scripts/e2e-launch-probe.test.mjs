import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const probe = readFileSync(join(ROOT, 'scripts', 'e2e-launch-probe.mjs'), 'utf8')
const suite = readFileSync(join(ROOT, 'e2e', 'support', 'launch.ts'), 'utf8')

test('the probe isolates exactly the way the suite does', () => {
  // A probe that isolates differently from the suite proves nothing about the suite: it could pass
  // while the suite still fails, or fail for a reason the suite would never hit. The mirrored
  // values are small, so the guard is a direct comparison of the names both files must set.
  for (const variable of [
    'ALETHE_E2E',
    'ALETHE_APP_DATA_DIR',
    'APPDATA',
    'LOCALAPPDATA',
    'HOME',
    'XDG_DATA_HOME',
  ]) {
    assert.ok(suite.includes(variable), `the suite sets ${variable}`)
    assert.ok(probe.includes(variable), `the probe sets ${variable}`)
  }
})

test('the probe launches the same binary the suite does', () => {
  // `target-e2e`, never `target`: the suite builds into an isolated directory so it never shares a
  // binary or a build lock with an interactive `tauri dev`.
  assert.ok(suite.includes("'target-e2e'"), 'the suite reads from target-e2e')
  assert.ok(probe.includes("'target-e2e'"), 'the probe reads from target-e2e')
  assert.ok(probe.includes("'alethe.exe'"), 'the probe knows the Windows binary name')
})

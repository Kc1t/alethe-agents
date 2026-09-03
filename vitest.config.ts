import { readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Tests under `src/lib/` that reach a DOM global — directly or through something they import — and
 * so have to keep the jsdom environment. Everything else in `src/lib/` is pure logic.
 *
 * Add a file here when a `node` run fails with `window is not defined` or similar; the split is
 * verified by file count below, so a mistake shows up as a failing run, never as a skipped test.
 */
const DOM_TESTS_IN_LIB = new Set([
  'src/lib/api/transport.test.ts',
  'src/lib/mountQueue.test.ts',
  'src/lib/overlayPresence.test.ts',
  'src/lib/resourceEvents.test.ts',
  'src/lib/sessionResume.test.ts',
  'src/lib/storageNamespace.test.ts',
  'src/lib/surfaceGeometry.test.ts',
])

/** Every `.test.ts` / `.spec.ts` under `src/lib/`, as forward-slashed repo-relative paths. */
function libTestFiles(dir = 'src/lib'): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).split(sep).join('/')
    if (entry.isDirectory()) found.push(...libTestFiles(path))
    else if (/\.(test|spec)\.ts$/.test(entry.name)) found.push(path)
  }
  return found
}

// The two projects are complements of each other, computed from one list rather than from two globs
// that have to agree. Globs that merely look opposite are how a file ends up in neither project and
// silently stops being tested.
const allLibTests = libTestFiles()
const nodeTests = allLibTests.filter((file) => !DOM_TESTS_IN_LIB.has(file))

const shared = {
  globals: true,
  // Node 22+ ships its own experimental global `localStorage`, which shadows
  // jsdom's implementation entirely (window.localStorage ends up undefined
  // too) unless disabled. Without this, any test touching localStorage fails
  // with "Cannot read properties of undefined".
  env: { NODE_OPTIONS: '--no-experimental-webstorage' },
  // Vitest defaults to `forks`, which pays for a full process spawn per worker. Process creation is
  // expensive on Windows and this suite is mostly pure logic, so worker threads start much faster.
  // Switch back to `forks` if a test ever needs real process isolation.
  pool: 'threads' as const,
  // Overriding `exclude` replaces Vitest's default list, so node_modules has to be repeated.
  exclude: ['**/node_modules/**', '**/dist/**'],
}

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          ...shared,
          // Building a jsdom instance per file was the single largest cost in this suite.
          name: 'node',
          environment: 'node',
          include: nodeTests,
        },
      },
      {
        plugins: [react()],
        test: {
          ...shared,
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: [...shared.exclude, ...nodeTests],
        },
      },
    ],
  },
})

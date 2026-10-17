import { beforeEach, describe, expect, it, vi } from 'vitest'

import { checkForUpdate, installPendingUpdate } from './updater'

const order = vi.hoisted(() => [] as string[])
const flush = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => ({
    version: '9.9.9',
    currentVersion: '1.0.0',
    download: vi.fn(async () => {
      order.push('download')
    }),
    install: vi.fn(async () => {
      order.push('install')
    }),
  })),
}))
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => {
    order.push('relaunch')
  }),
}))
vi.mock('../stores/projectsStore', () => ({ flushProjectsState: flush }))

beforeEach(() => {
  order.length = 0
  flush.mockReset()
  flush.mockImplementation(async () => {
    order.push('flush')
  })
})

describe('installPendingUpdate', () => {
  it('saves the workspace before the installer takes the process down', async () => {
    await checkForUpdate()
    await installPendingUpdate()

    expect(order).toEqual(['download', 'flush', 'install', 'relaunch'])
  })

  it('still installs when the workspace cannot be saved', async () => {
    flush.mockRejectedValueOnce(new Error('disk full'))
    await checkForUpdate()
    await installPendingUpdate()

    expect(order).toEqual(['download', 'install', 'relaunch'])
  })
})

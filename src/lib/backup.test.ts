import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import { announceBackup, backupSummary, exportProfileState, importProfileState } from './backup'
import { setStorageNamespace } from './storageNamespace'
import { exportBackup, exportProfileBackup, importBackup } from './tauri/misc'

vi.mock('./tauri/misc', () => ({
  exportBackup: vi.fn(async () => ({ skipped: [], embeddedImages: 0, imageLinksKept: [] })),
  exportProfileBackup: vi.fn(async () => ({ skipped: [], embeddedImages: 0, imageLinksKept: [] })),
  importBackup: vi.fn(async () => ({
    localStorage: { 'promptHistory:pty-1': '["npm test"]' },
    profileName: 'Kc1t',
  })),
}))

describe('backup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setStorageNamespace('default')
  })

  it("sends the profile's local state along with the export", async () => {
    localStorage.setItem('alethe:default:promptHistory:pty-1', '["npm test"]')
    localStorage.setItem('alethe:work:promptHistory:pty-2', '["ls"]')

    await exportProfileState('C:/backups/a.zip')
    await exportProfileState('C:/backups/b.zip', 'work')

    expect(exportBackup).toHaveBeenCalledWith('C:/backups/a.zip', {
      'promptHistory:pty-1': '["npm test"]',
    })
    expect(exportProfileBackup).toHaveBeenCalledWith('work', 'C:/backups/b.zip', {
      'promptHistory:pty-2': '["ls"]',
    })
  })

  it('puts the local state back under the active profile on import', async () => {
    setStorageNamespace('restored')
    await importProfileState('C:/backups/a.zip')
    expect(importBackup).toHaveBeenCalledWith('C:/backups/a.zip')
    expect(localStorage.getItem('alethe:restored:promptHistory:pty-1')).toBe('["npm test"]')
  })

  it('says what the backup holds and what it had to leave out', () => {
    expect(backupSummary({ skipped: [], embeddedImages: 2, imageLinksKept: [] }, 'en')).toBe(
      'Projects, settings, theme, profile name and photo, and terminal history are all in the file. Linked images saved inside the backup: 2.',
    )
    expect(
      backupSummary(
        {
          skipped: ['a.db (in use)', 'b.db (in use)', 'c.db (in use)', 'd.db (in use)'],
          embeddedImages: 0,
          imageLinksKept: ['https://gone.example/x.png'],
        },
        'en',
      ),
    ).toBe(
      'Files in use that were left out (4): a.db (in use), b.db (in use), c.db (in use) (+1). Linked images that could not be downloaded and stay as links: 1.',
    )
  })

  it('announces the saved backup as a notification', () => {
    const pushToast = vi.spyOn(useUiStore.getState(), 'pushToast')
    announceBackup({ skipped: [], embeddedImages: 0, imageLinksKept: [] })
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Backup saved' }))
  })
})

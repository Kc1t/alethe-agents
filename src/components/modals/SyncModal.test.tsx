import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  githubSyncStatus: vi.fn(),
  cloudSyncStatus: vi.fn(),
  githubSyncPush: vi.fn(),
  githubSyncPull: vi.fn(),
  cloudSyncPush: vi.fn(),
  cloudSyncPull: vi.fn(),
  githubSyncSetToken: vi.fn(),
  githubSyncLogout: vi.fn(),
  cloudSyncLogout: vi.fn(),
  cloudSyncDeviceStart: vi.fn(),
  cloudSyncDeviceFinish: vi.fn(),
  openInBrowser: vi.fn(),
}))

vi.mock('../../lib/tauri', () => tauri)
vi.mock('../../lib/cloudSync', () => ({
  buildCloudPayload: vi.fn().mockResolvedValue({}),
  applyCloudPayload: vi.fn().mockResolvedValue(true),
}))

const store = vi.hoisted(() => ({
  pushToast: vi.fn(),
  openModal_: vi.fn(),
  hydrate: vi.fn().mockResolvedValue(undefined),
  setPreferences: vi.fn(),
  setLanguage: vi.fn(),
  getState: vi.fn(() => ({ preferences: { language: 'en' } })),
}))

vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        preferences: { language: 'en', displayName: 'Ada', profileImageUrl: '' },
        hydrate: store.hydrate,
        setPreferences: store.setPreferences,
        setLanguage: store.setLanguage,
      }),
    { getState: store.getState },
  ),
}))

vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      openModal: 'sync',
      openModal_: store.openModal_,
      closeModal: vi.fn(),
      pushToast: store.pushToast,
    }),
}))

import { AccountPage } from './preferences/AccountPage'
import { SyncModal } from './SyncModal'

const disconnected = {
  connected: false,
  login: null,
  gist_id: null,
  gist_url: null,
  last_push_ms: null,
  last_pull_ms: null,
}
const connected = { ...disconnected, connected: true, login: 'octocat' }

beforeEach(() => {
  vi.clearAllMocks()
  tauri.githubSyncStatus.mockResolvedValue(connected)
  tauri.cloudSyncStatus.mockResolvedValue({ configured: false, connected: false })
  tauri.githubSyncPush.mockResolvedValue(connected)
  tauri.githubSyncPull.mockResolvedValue(connected)
  tauri.cloudSyncPush.mockResolvedValue({})
  tauri.cloudSyncPull.mockResolvedValue({})
})

afterEach(cleanup)

describe('SyncModal feedback', () => {
  it.each([
    ['push', 'Data uploaded to your Gist.'],
    ['pull', 'Data restored from your Gist.'],
  ] as const)('shows success feedback after gist %s', async (action, message) => {
    render(<SyncModal />)
    const buttonName = action === 'push' ? 'Upload' : 'Download'
    fireEvent.click(await screen.findByRole('button', { name: buttonName }))
    if (action === 'pull') {
      const pullButtons = screen.getAllByRole('button', { name: 'Download' })
      fireEvent.click(pullButtons[pullButtons.length - 1]!)
    }
    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument())
    expect(store.pushToast).toHaveBeenCalledWith({ title: message, body: '' })
  })

  it.each([
    ['push', 'githubSyncPush'],
    ['pull', 'githubSyncPull'],
  ] as const)('shows error feedback when gist %s rejects', async (action, method) => {
    tauri[method].mockRejectedValue('not_connected')
    render(<SyncModal />)
    fireEvent.click(
      await screen.findByRole('button', { name: action === 'push' ? 'Upload' : 'Download' }),
    )
    if (action === 'pull') {
      const pullButtons = screen.getAllByRole('button', { name: 'Download' })
      fireEvent.click(pullButtons[pullButtons.length - 1]!)
    }
    await waitFor(() => expect(screen.getByText('Connect to GitHub first.')).toBeInTheDocument())
    expect(store.pushToast).toHaveBeenCalledWith({ title: 'Connect to GitHub first.', body: '' })
  })

  it('shows the busy label while a gist push is in flight', async () => {
    let finish!: (value: typeof connected) => void
    tauri.githubSyncPush.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    render(<SyncModal />)
    fireEvent.click(await screen.findByRole('button', { name: 'Upload' }))
    expect(await screen.findByRole('button', { name: 'Uploading…' })).toBeDisabled()
    finish(connected)
    await screen.findByText('Data uploaded to your Gist.')
  })

  it('shows cloud push success feedback when the cloud account is connected', async () => {
    tauri.cloudSyncStatus.mockResolvedValue({
      configured: true,
      connected: true,
      login: 'octocat',
      last_push_ms: null,
      last_pull_ms: null,
    })
    render(<SyncModal />)
    const pushButtons = await screen.findAllByRole('button', { name: 'Upload' })
    fireEvent.click(pushButtons[pushButtons.length - 1]!)
    await waitFor(() => expect(screen.getByText('Preferences uploaded.')).toBeInTheDocument())
    expect(store.pushToast).toHaveBeenCalledWith({ title: 'Preferences uploaded.', body: '' })
  })

  it('lets an existing profile open the sync modal from Account preferences', () => {
    render(<AccountPage avatarUrl={null} initial="A" onManageAccounts={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync your data' }))
    expect(store.openModal_).toHaveBeenCalledWith('sync')
  })
})

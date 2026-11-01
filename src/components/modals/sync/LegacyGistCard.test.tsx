import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  githubSyncStatus: vi.fn(),
  githubSyncPull: vi.fn(),
  githubSyncLogout: vi.fn(),
}))

vi.mock('../../../lib/tauri', () => tauri)

const store = vi.hoisted(() => ({
  pushToast: vi.fn(),
  openModal_: vi.fn(),
  hydrate: vi.fn().mockResolvedValue(undefined),
  setPreferences: vi.fn(),
  setLanguage: vi.fn(),
}))

vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({
      preferences: { language: 'en', displayName: 'Ada', profileImageUrl: '' },
      hydrate: store.hydrate,
      setPreferences: store.setPreferences,
      setLanguage: store.setLanguage,
    }),
}))

vi.mock('../../../stores/uiStore', () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({ openModal_: store.openModal_, pushToast: store.pushToast }),
}))

import { AccountPage } from '../preferences/AccountPage'
import { LegacyGistCard } from './LegacyGistCard'

const connected = {
  connected: true,
  login: 'octocat',
  gist_id: 'abc',
  gist_url: null,
  last_push_ms: null,
  last_pull_ms: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  tauri.githubSyncStatus.mockResolvedValue(connected)
  tauri.githubSyncPull.mockResolvedValue(connected)
})

afterEach(cleanup)

async function downloadFromGist() {
  render(<LegacyGistCard open />)
  fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
  const confirm = screen.getAllByRole('button', { name: 'Download' })
  fireEvent.click(confirm[confirm.length - 1]!)
}

describe('LegacyGistCard feedback', () => {
  it('reports a gist download inline and as a toast', async () => {
    await downloadFromGist()
    await waitFor(() =>
      expect(screen.getByText('Data restored from your Gist.')).toBeInTheDocument(),
    )
    expect(store.hydrate).toHaveBeenCalled()
    expect(store.pushToast).toHaveBeenCalledWith({
      title: 'Data restored from your Gist.',
      body: '',
    })
  })

  it('reports a failed gist download inline and as a toast', async () => {
    tauri.githubSyncPull.mockRejectedValue('not_connected')
    await downloadFromGist()
    await waitFor(() => expect(screen.getByText('Sign in first.')).toBeInTheDocument())
    expect(store.pushToast).toHaveBeenCalledWith({ title: 'Sign in first.', body: '' })
  })
})

describe('AccountPage', () => {
  it('opens the sync dialog for an existing profile', () => {
    render(<AccountPage avatarUrl={null} initial="A" onManageAccounts={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync your data' }))
    expect(store.openModal_).toHaveBeenCalledWith('sync')
  })
})

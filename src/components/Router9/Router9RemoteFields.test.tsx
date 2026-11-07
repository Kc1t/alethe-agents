import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ router9SetRemoteKey: vi.fn() }))
vi.mock('../../lib/tauri', () => tauri)

vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: { language: 'en' } }),
}))

import { DEFAULT_ROUTER9_PREFERENCES, type Router9Preferences } from '../../lib/types'
import { Router9RemoteFields } from './Router9RemoteFields'

const ready: Router9Preferences = {
  ...DEFAULT_ROUTER9_PREFERENCES,
  enabled: true,
  mode: 'remote',
  remoteUrl: 'https://gw.example.com',
  models: { opus: 'cc/o', sonnet: 'cc/s', haiku: 'cc/h', codex: 'cx/c' },
}

function renderFields(overrides: Partial<Parameters<typeof Router9RemoteFields>[0]> = {}) {
  const onKeyChanged = vi.fn().mockResolvedValue(undefined)
  render(
    <Router9RemoteFields
      config={ready}
      patch={vi.fn()}
      keySaved
      onKeyChanged={onKeyChanged}
      {...overrides}
    />,
  )
  return { onKeyChanged }
}

describe('Router9RemoteFields', () => {
  beforeEach(() => {
    tauri.router9SetRemoteKey.mockReset()
    tauri.router9SetRemoteKey.mockResolvedValue(undefined)
  })
  afterEach(cleanup)

  it('lists what is ready without ever showing the key', () => {
    renderFields()

    expect(screen.getByText('Gateway https://gw.example.com')).toBeTruthy()
    expect(screen.getByText('Key saved in the system keychain')).toBeTruthy()
    expect(screen.getByText('4 of 4 model ids set')).toBeTruthy()
    expect((screen.getByLabelText('Gateway key') as HTMLInputElement).value).toBe('')
  })

  it('saves a pasted key to the keychain and clears the field', async () => {
    const { onKeyChanged } = renderFields({ keySaved: false })
    const input = screen.getByLabelText('Gateway key') as HTMLInputElement

    fireEvent.change(input, { target: { value: '  or_secret_key  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))

    await waitFor(() => expect(onKeyChanged).toHaveBeenCalled())
    expect(tauri.router9SetRemoteKey).toHaveBeenCalledWith('or_secret_key')
    expect(input.value).toBe('')
  })

  it('removes the saved key on request', async () => {
    const { onKeyChanged } = renderFields()

    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }))

    await waitFor(() => expect(onKeyChanged).toHaveBeenCalled())
    expect(tauri.router9SetRemoteKey).toHaveBeenCalledWith('')
  })

  it('says why a key could not be saved', async () => {
    tauri.router9SetRemoteKey.mockRejectedValue('secure_store_unavailable: write')
    renderFields({ keySaved: false })

    fireEvent.change(screen.getByLabelText('Gateway key'), { target: { value: 'or_k' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))

    expect(
      await screen.findByText('Could not save the key: secure_store_unavailable: write'),
    ).toBeTruthy()
  })

  it('confirms with Done that routing is saved and live', async () => {
    renderFields()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain(
      'Saved. New terminals with Route through 9router go through https://gw.example.com.',
    )
  })

  it('refuses to confirm without a saved key or with a refused URL', async () => {
    renderFields({ keySaved: false })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('Not ready yet: fix the items marked above.')).toBeTruthy()
    cleanup()

    renderFields({ config: { ...ready, remoteUrl: 'http://gw.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('Not ready yet: fix the items marked above.')).toBeTruthy()
    expect(screen.queryByText(/^Saved\./)).toBeNull()
  })
})

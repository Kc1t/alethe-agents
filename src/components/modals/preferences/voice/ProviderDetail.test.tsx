import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderDetail } from './ProviderDetail'

const tauri = vi.hoisted(() => ({ voiceProviderCatalog: vi.fn() }))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))
vi.mock('../../../../lib/i18n', () => ({
  useT: () => (key: string) => key,
  getLocale: () => 'en',
  intlLocale: () => 'en',
}))
vi.mock('./CloudKeyForm', () => ({ CloudKeyForm: () => <div>key-form</div> }))
vi.mock('./BuiltInProviderView', () => ({
  BuiltInProviderView: ({ id }: { id: string }) => <div>{`built-in-${id}`}</div>,
}))
vi.mock('./LocalModelsView', () => ({
  LocalModelsView: ({ initialFilter }: { initialFilter?: string }) => (
    <div>{`local-models-${initialFilter ?? 'none'}`}</div>
  ),
}))

afterEach(cleanup)

describe('ProviderDetail', () => {
  it('shows an error with retry when the catalog fails, then the key form on success', async () => {
    tauri.voiceProviderCatalog
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce([{ provider: 'openai', keyUrl: 'https://x', models: [], voices: [] }])
    render(<ProviderDetail id="openai" onBack={() => undefined} />)
    await screen.findByText('prefs.voiceDetailCatalogFailed')
    expect(screen.queryByText('key-form')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceRetry' }))
    await waitFor(() => expect(screen.getByText('key-form')).toBeTruthy())
    expect(screen.queryByText('prefs.voiceDetailCatalogFailed')).toBeNull()
  })

  it('opens Local models with the requested filter under the Accounts and models crumb', () => {
    tauri.voiceProviderCatalog.mockResolvedValue([])
    const onBack = vi.fn()
    render(<ProviderDetail id="local" filter="tts" onBack={onBack} />)
    expect(screen.getByText('local-models-tts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceAccountsTitle' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows the cloud models table under the key form', async () => {
    tauri.voiceProviderCatalog.mockResolvedValue([
      {
        provider: 'openai',
        keyUrl: 'https://x',
        models: [{ id: 'whisper-1', label: 'Whisper', capability: 'stt' }],
        voices: [],
      },
    ])
    render(<ProviderDetail id="openai" onBack={() => undefined} />)
    expect(await screen.findByRole('button', { name: /^Whisper$/ })).toBeTruthy()
    expect(screen.getByText('key-form')).toBeTruthy()
    expect(screen.getByRole('rowgroup', { name: 'prefs.voiceSectionSttTitle' })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows the built-in views for Apple Speech and the system voice', () => {
    tauri.voiceProviderCatalog.mockResolvedValue([])
    render(<ProviderDetail id="apple" onBack={() => undefined} />)
    expect(screen.getByText('built-in-apple')).toBeTruthy()
    expect(screen.queryByText('prefs.voiceDetailBuiltIn')).toBeNull()
    cleanup()
    render(<ProviderDetail id="system" onBack={() => undefined} />)
    expect(screen.getByText('built-in-system')).toBeTruthy()
    expect(screen.queryByText('key-form')).toBeNull()
  })

  it('opens Local models unfiltered by default', () => {
    tauri.voiceProviderCatalog.mockResolvedValue([])
    render(<ProviderDetail id="local" onBack={() => undefined} />)
    expect(screen.getByText('local-models-none')).toBeTruthy()
  })
})

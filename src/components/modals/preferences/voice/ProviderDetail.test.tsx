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
})

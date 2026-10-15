import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalModelList } from './LocalModelList'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  speechDownloadModel: vi.fn().mockResolvedValue({ id: 'whisper-base-int8', status: 'ready' }),
  speechDeleteModel: vi.fn().mockResolvedValue(undefined),
  onSpeechDownloadProgress: vi.fn().mockResolvedValue(() => undefined),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))
vi.mock('../../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getLocale: () => 'en',
  intlLocale: () => 'en',
}))

afterEach(cleanup)

const model = (id: string, capability: 'stt' | 'tts') => ({
  id,
  label: id,
  description: '',
  language: 'multilingual',
  sampleRate: 16000,
  sizeBytes: 1024 * 1024,
  recommended: false,
  kind: 'download',
  capability,
})

describe('LocalModelList', () => {
  it('lists downloadable models of the capability and downloads one', async () => {
    tauri.speechListModels.mockResolvedValue([
      model('whisper-base-int8', 'stt'),
      model('piper-pt-br', 'tts'),
    ])
    tauri.speechModelStates.mockResolvedValue([
      { id: 'whisper-base-int8', status: 'not-downloaded' },
    ])
    render(<LocalModelList capability="stt" />)
    const row = await screen.findByRole('listitem', { name: 'whisper-base-int8' })
    expect(screen.queryByRole('listitem', { name: 'piper-pt-br' })).toBeNull()
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() =>
      expect(tauri.speechDownloadModel).toHaveBeenCalledWith('whisper-base-int8', null),
    )
  })
})

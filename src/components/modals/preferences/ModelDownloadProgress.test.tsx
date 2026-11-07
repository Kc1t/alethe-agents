import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getLocale: () => 'en',
  intlLocale: () => 'en-US',
}))

import type { SpeechDownloadProgress } from '../../../lib/tauri'
import { ModelDownloadProgress } from './ModelDownloadProgress'

const progress = (overrides: Partial<SpeechDownloadProgress> = {}): SpeechDownloadProgress => ({
  modelId: 'm',
  downloaded: 326_000_000,
  total: 670_000_000,
  fraction: 326 / 670,
  phase: 'downloading',
  file: 'encoder.int8.onnx',
  fileIndex: 1,
  fileCount: 4,
  ...overrides,
})

describe('ModelDownloadProgress', () => {
  it('shows a bar with the downloaded share', () => {
    render(<ModelDownloadProgress progress={progress()} bytesPerSecond={null} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('49')
  })

  it('shows bytes, the file being fetched, and that the speed is being measured', () => {
    render(<ModelDownloadProgress progress={progress()} bytesPerSecond={null} />)
    expect(screen.getByText(/prefs\.dictationModelProgressBytes/).textContent).toContain('326 MB')
    expect(screen.getByText(/prefs\.dictationModelFile/).textContent).toContain('encoder.int8.onnx')
    expect(screen.getByText('prefs.dictationModelMeasuring')).toBeTruthy()
  })

  it('shows the speed and the time left once known', () => {
    render(<ModelDownloadProgress progress={progress()} bytesPerSecond={8_600_000} />)
    const line = screen.getByText(/prefs\.dictationModelSpeed/).textContent ?? ''
    expect(line).toContain('8.6 MB/s')
    expect(line).toContain('40 sec')
  })

  it('says it is checking the file instead of sitting at 100%', () => {
    render(
      <ModelDownloadProgress
        progress={progress({ phase: 'verifying', downloaded: 670_000_000, fraction: 1 })}
        bytesPerSecond={8_600_000}
      />,
    )
    expect(screen.getByText(/prefs\.dictationModelVerifying/)).toBeTruthy()
    expect(screen.queryByText(/prefs\.dictationModelSpeed/)).toBeNull()
  })

  it('a download shows bytes and speed by default', () => {
    render(<ModelDownloadProgress progress={progress()} bytesPerSecond={8_600_000} />)
    expect(screen.getByText(/prefs\.dictationModelProgressBytes/)).toBeTruthy()
    expect(screen.getByText(/prefs\.dictationModelSpeed/)).toBeTruthy()
  })

  it('an install shows only the bar, the percent and the file', () => {
    render(
      <ModelDownloadProgress
        variant="install"
        progress={progress({ downloaded: 250, total: 1000, fraction: 0.25, file: 'pt-BR' })}
        bytesPerSecond={8_600_000}
      />,
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getByText('prefs.dictationModelProgress:{"percent":25}')).toBeTruthy()
    expect(screen.getByText(/prefs\.dictationModelFile/).textContent).toContain('pt-BR')
    expect(screen.queryByText(/prefs\.dictationModelProgressBytes/)).toBeNull()
    expect(screen.queryByText(/prefs\.dictationModelSpeed/)).toBeNull()
    expect(screen.queryByText('prefs.dictationModelMeasuring')).toBeNull()
  })
})

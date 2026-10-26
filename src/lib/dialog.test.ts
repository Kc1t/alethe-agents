import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { confirmAction, promptText, showMessage } from './dialog'

const native = vi.hoisted(() => ({
  confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  message: vi.fn<(...args: unknown[]) => Promise<string>>(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: native.confirm,
  message: native.message,
  open: vi.fn(),
  save: vi.fn(),
}))

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

function enterTauri() {
  ;(window as TauriWindow).__TAURI_INTERNALS__ = {}
}

beforeEach(() => {
  const { preferences } = useProjectsStore.getState()
  useProjectsStore.setState({ preferences: { ...preferences, language: 'en' } })
  native.confirm.mockReset()
  native.message.mockReset()
})

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('confirmAction', () => {
  it('falls back to window.confirm outside Tauri', async () => {
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)

    await expect(confirmAction('Delete it?')).resolves.toBe(true)
    expect(confirmSpy).toHaveBeenCalledWith('Delete it?')
    expect(native.confirm).not.toHaveBeenCalled()
  })

  it('uses window.confirm under WebDriver so the E2E suite can answer it', async () => {
    enterTauri()
    Object.defineProperty(window.navigator, 'webdriver', { configurable: true, value: true })
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)

    try {
      await expect(confirmAction('Delete it?')).resolves.toBe(false)
      expect(confirmSpy).toHaveBeenCalledOnce()
      expect(native.confirm).not.toHaveBeenCalled()
    } finally {
      delete (window.navigator as { webdriver?: boolean }).webdriver
    }
  })

  it('asks through the native dialog with translated buttons under Tauri', async () => {
    enterTauri()
    native.confirm.mockResolvedValue(true)

    await expect(confirmAction('Delete it?', { title: 'Delete' })).resolves.toBe(true)
    expect(native.confirm).toHaveBeenCalledWith('Delete it?', {
      title: 'Delete',
      kind: 'warning',
      okLabel: 'OK',
      cancelLabel: 'Cancel',
    })
  })

  it('falls back to the in-app dialog when the native one fails', async () => {
    enterTauri()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    native.confirm.mockRejectedValue(new Error('not allowed'))
    const onNativeError = vi.fn()

    const answer = confirmAction('Delete it?', { onNativeError })
    const ok = await screen.findByRole('button', { name: 'OK' })
    expect(screen.getByText('Delete it?')).toBeInTheDocument()
    await act(async () => fireEvent.click(ok))

    await expect(answer).resolves.toBe(true)
    expect(onNativeError).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('showMessage', () => {
  it('falls back to window.alert outside Tauri', async () => {
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)

    await showMessage('Saved')
    expect(alertSpy).toHaveBeenCalledWith('Saved')
  })

  it('uses the native message dialog under Tauri', async () => {
    enterTauri()
    native.message.mockResolvedValue('Ok')

    await showMessage('Failed', { kind: 'error' })
    expect(native.message).toHaveBeenCalledWith('Failed', {
      title: undefined,
      kind: 'error',
      okLabel: 'OK',
    })
  })
})

describe('promptText', () => {
  it('resolves with the submitted text', async () => {
    const answer = promptText('New name:', { defaultValue: 'old' })
    const input = await screen.findByRole('textbox', { name: 'New name:' })
    expect(input).toHaveValue('old')

    fireEvent.change(input, { target: { value: 'renamed' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))

    await expect(answer).resolves.toBe('renamed')
  })

  it('resolves null when cancelled, like window.prompt', async () => {
    const answer = promptText('New name:')
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await act(async () => fireEvent.click(cancel))

    await expect(answer).resolves.toBeNull()
  })

  it('shows queued prompts one at a time', async () => {
    const first = promptText('First')
    const second = promptText('Second')
    await screen.findByRole('textbox', { name: 'First' })
    expect(screen.queryByRole('textbox', { name: 'Second' })).not.toBeInTheDocument()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'OK' })))
    await expect(first).resolves.toBe('')
    const next = await screen.findByRole('textbox', { name: 'Second' })
    await act(async () => fireEvent.keyDown(next, { key: 'Enter' }))
    await expect(second).resolves.toBe('')
  })
})

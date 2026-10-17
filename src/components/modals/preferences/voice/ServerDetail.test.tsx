import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import { ServerDetail } from './ServerDetail'

const tauri = vi.hoisted(() => ({
  voiceServersList: vi.fn(),
  voiceServersSave: vi.fn(),
  voiceServersDelete: vi.fn(),
  voiceServersTest: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const saved = {
  id: 'V1StGXR8_Z5jdHi6B-myT',
  name: 'Fish',
  kind: 'fish' as const,
  baseUrl: 'http://192.168.0.5:8080',
  model: null,
  hasKey: false,
}

afterEach(cleanup)

describe('ServerDetail', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    useVoiceServersStore.setState({ servers: [], loaded: true, health: {} })
    Object.values(tauri).forEach((fn) => fn.mockReset())
    tauri.voiceServersList.mockResolvedValue([saved])
    tauri.voiceServersSave.mockResolvedValue({ server: saved, loopback: false })
    tauri.voiceServersTest.mockResolvedValue({
      ok: true,
      reason: null,
      voices: ['a', 'b'],
      loopback: false,
    })
  })

  it('creates a server, shows the LAN notice and tests it', async () => {
    const onBack = vi.fn()
    render(<ServerDetail serverId={null} onBack={onBack} />)
    fireEvent.change(screen.getByLabelText('prefs.voiceServerName'), { target: { value: 'Fish' } })
    fireEvent.change(screen.getByLabelText('prefs.voiceServerAddress'), {
      target: { value: 'http://192.168.0.5:8080' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerSave' }))
    await waitFor(() =>
      expect(tauri.voiceServersSave).toHaveBeenCalledWith(
        { name: 'Fish', kind: 'openai', baseUrl: 'http://192.168.0.5:8080', model: null },
        null,
      ),
    )
    expect(await screen.findByText('prefs.voiceServerLanNotice')).toBeTruthy()
    await waitFor(() => expect(tauri.voiceServersTest).toHaveBeenCalledWith(saved.id))
    expect(await screen.findByText('prefs.voiceServerOnline:{"count":2}')).toBeTruthy()
    expect(useVoiceServersStore.getState().health[saved.id]).toBe('connected')
  })

  it('keeps the LAN notice when the test of a LAN server fails', async () => {
    tauri.voiceServersSave.mockResolvedValue({ server: saved, loopback: false })
    tauri.voiceServersTest.mockResolvedValue({
      ok: false,
      reason: 'network',
      voices: [],
      loopback: true,
    })
    render(<ServerDetail serverId={null} onBack={() => undefined} />)
    fireEvent.change(screen.getByLabelText('prefs.voiceServerName'), { target: { value: 'Fish' } })
    fireEvent.change(screen.getByLabelText('prefs.voiceServerAddress'), {
      target: { value: 'http://192.168.0.5:8080' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerSave' }))
    expect(await screen.findByText('prefs.voiceServerError.network')).toBeTruthy()
    expect(screen.getByText('prefs.voiceServerLanNotice')).toBeTruthy()
  })

  it('shows the LAN notice at once for an existing LAN server', () => {
    useVoiceServersStore.setState({ servers: [saved], loaded: true, health: {} })
    render(<ServerDetail serverId={saved.id} onBack={() => undefined} />)
    expect(screen.getByText('prefs.voiceServerLanNotice')).toBeTruthy()
  })

  it('shows a policy error inline', async () => {
    tauri.voiceServersSave.mockRejectedValue('voice_server_policy')
    render(<ServerDetail serverId={null} onBack={() => undefined} />)
    fireEvent.change(screen.getByLabelText('prefs.voiceServerName'), { target: { value: 'X' } })
    fireEvent.change(screen.getByLabelText('prefs.voiceServerAddress'), {
      target: { value: 'http://8.8.8.8' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerSave' }))
    expect(await screen.findByText('prefs.voiceServerError.policy')).toBeTruthy()
  })

  it('uses a saved server for narration and removes it', async () => {
    useVoiceServersStore.setState({ servers: [saved], loaded: true, health: {} })
    const onBack = vi.fn()
    render(<ServerDetail serverId={saved.id} onBack={onBack} />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerUse' }))
    expect(useProjectsStore.getState().preferences.voiceTts).toMatchObject({
      provider: 'server',
      server: saved.id,
      model: '',
      voice: null,
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceServerRemove' }))
    await waitFor(() => expect(tauri.voiceServersDelete).toHaveBeenCalledWith(saved.id))
    await waitFor(() => expect(onBack).toHaveBeenCalled())
  })
})

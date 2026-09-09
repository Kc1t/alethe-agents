import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  listWslDistros: vi.fn(),
  wslDistroHome: vi.fn(),
}))

const dialog = vi.hoisted(() => ({
  pickDirectory: vi.fn(),
}))

vi.mock('../../lib/tauri', () => tauri)

vi.mock('../../lib/dialog', () => dialog)

const features = vi.hoisted(() => ({ wsl: true }))

vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: (
    selector: (state: {
      preferences: { language: string; enabledFeatures: { wsl: boolean } }
    }) => unknown,
  ) => selector({ preferences: { language: 'en', enabledFeatures: features } }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector: (state: { pushToast: () => void }) => unknown) =>
    selector({ pushToast: vi.fn() }),
}))

import { WslPathPicker } from './WslPathPicker'

afterEach(() => {
  cleanup()
  features.wsl = true
})

beforeEach(() => {
  tauri.listWslDistros.mockReset()
  tauri.wslDistroHome.mockReset()
  dialog.pickDirectory.mockReset()
  dialog.pickDirectory.mockResolvedValue(null)
})

describe('WslPathPicker', () => {
  it('renders nothing when the host has no WSL distros', async () => {
    tauri.listWslDistros.mockResolvedValue([])

    const { container } = render(<WslPathPicker onPick={vi.fn()} />)

    await waitFor(() => expect(tauri.listWslDistros).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing, and never asks for distros, while the WSL integration is disabled', async () => {
    features.wsl = false
    tauri.listWslDistros.mockResolvedValue(['Ubuntu'])

    const { container } = render(<WslPathPicker onPick={vi.fn()} />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(tauri.listWslDistros).not.toHaveBeenCalled()
  })

  it('renders a trigger when distros are installed', async () => {
    tauri.listWslDistros.mockResolvedValue(['Ubuntu', 'Debian'])

    render(<WslPathPicker onPick={vi.fn()} />)

    expect(await screen.findByRole('button', { name: 'WSL' })).toBeInTheDocument()
  })

  it('opens the folder browser inside the chosen distro and picks the browsed directory', async () => {
    tauri.listWslDistros.mockResolvedValue(['Ubuntu', 'Debian'])
    tauri.wslDistroHome.mockResolvedValue(String.raw`\\wsl.localhost\Debian\home\dev`)
    dialog.pickDirectory.mockResolvedValue(
      String.raw`\\wsl.localhost\Debian\home\dev\projects\acme`,
    )
    const onPick = vi.fn()

    render(<WslPathPicker onPick={onPick} />)

    fireEvent.click(await screen.findByRole('button', { name: 'WSL' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debian' }))

    await waitFor(() =>
      expect(dialog.pickDirectory).toHaveBeenCalledWith({
        defaultPath: String.raw`\\wsl.localhost\Debian\home\dev`,
      }),
    )
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(
        String.raw`\\wsl.localhost\Debian\home\dev\projects\acme`,
      ),
    )
    expect(tauri.wslDistroHome).toHaveBeenCalledWith('Debian')
  })

  it('leaves the field untouched when the folder browser is cancelled', async () => {
    tauri.listWslDistros.mockResolvedValue(['Debian'])
    tauri.wslDistroHome.mockResolvedValue(String.raw`\\wsl.localhost\Debian\home\dev`)
    dialog.pickDirectory.mockResolvedValue(null)
    const onPick = vi.fn()

    render(<WslPathPicker onPick={onPick} />)

    fireEvent.click(await screen.findByRole('button', { name: 'WSL' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debian' }))

    await waitFor(() => expect(dialog.pickDirectory).toHaveBeenCalled())
    expect(onPick).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'WSL' })).not.toBeDisabled())
  })

  it('opens the folder browser at the distro root when the home directory cannot be probed', async () => {
    tauri.listWslDistros.mockResolvedValue(['Debian'])
    tauri.wslDistroHome.mockResolvedValue(null)
    dialog.pickDirectory.mockResolvedValue(String.raw`\\wsl.localhost\Debian\home\dev`)
    const onPick = vi.fn()

    render(<WslPathPicker onPick={onPick} />)

    fireEvent.click(await screen.findByRole('button', { name: 'WSL' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debian' }))

    await waitFor(() =>
      expect(dialog.pickDirectory).toHaveBeenCalledWith({
        defaultPath: String.raw`\\wsl.localhost\Debian`,
      }),
    )
    expect(onPick).toHaveBeenCalledWith(String.raw`\\wsl.localhost\Debian\home\dev`)
  })

  it('opens the folder browser at the distro root when probing the home directory throws', async () => {
    tauri.listWslDistros.mockResolvedValue(['Debian'])
    tauri.wslDistroHome.mockRejectedValue(new Error('wsl unavailable'))
    dialog.pickDirectory.mockResolvedValue(String.raw`\\wsl.localhost\Debian\home\dev\projects`)
    const onPick = vi.fn()

    render(<WslPathPicker onPick={onPick} />)

    fireEvent.click(await screen.findByRole('button', { name: 'WSL' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debian' }))

    await waitFor(() =>
      expect(dialog.pickDirectory).toHaveBeenCalledWith({
        defaultPath: String.raw`\\wsl.localhost\Debian`,
      }),
    )
    expect(onPick).toHaveBeenCalledWith(String.raw`\\wsl.localhost\Debian\home\dev\projects`)
  })
})

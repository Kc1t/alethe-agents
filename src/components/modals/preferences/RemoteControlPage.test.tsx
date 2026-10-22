import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlInfo } from '../../../lib/tauri'

const mocks = vi.hoisted(() => ({
  info: vi.fn<() => Promise<RemoteControlInfo>>(),
  tailscale: vi.fn(async () => ({ installed: false, connected: false })),
}))

vi.mock('../../../lib/tauri', () => ({
  closeRemoteControlPairing: vi.fn(),
  openRemoteControlPairing: vi.fn(),
  remoteControlInfo: mocks.info,
  remoteControlRevoke: vi.fn(),
  remoteControlTailscaleStatus: mocks.tailscale,
  revokeRemoteControlDevice: vi.fn(),
}))

vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({
      preferences: { remoteEnabled: true, remoteReadOnly: true },
      setPreferences: vi.fn(),
    }),
}))

import { RemoteControlPage } from './RemoteControlPage'

const info = (overrides: Partial<RemoteControlInfo> = {}): RemoteControlInfo => ({
  enabled: true,
  connected_devices: 0,
  online_devices: 0,
  max_devices: 1,
  session_expiry_secs: 3600,
  read_only: true,
  allow_shell_input: false,
  reach_mode: 'lan',
  pairing_open: true,
  pairing_expires_in: 120,
  devices: [],
  pairing_url: 'http://192.168.1.2:1420/pair/abc',
  qr_svg: '<svg></svg>',
  http_url: null,
  ws_url: null,
  ...overrides,
})

beforeEach(() => {
  mocks.info.mockResolvedValue(info())
  mocks.tailscale.mockResolvedValue({ installed: false, connected: false })
})

describe('RemoteControlPage pairing credentials', () => {
  it('shows the QR code and readable pairing address while pairing is active', async () => {
    render(<RemoteControlPage />)

    expect(
      await screen.findByRole('img', { name: 'Remote control pairing QR code' }),
    ).toHaveAttribute('src', expect.stringContaining(encodeURIComponent('<svg></svg>')))
    expect(screen.getByText('http://192.168.1.2:1420/pair/abc')).toBeInTheDocument()
  })

  it.each([
    ['closed pairing', { pairing_open: false }],
    ['missing pairing address', { pairing_url: null }],
  ])('hides credentials for %s', async (_, overrides) => {
    mocks.info.mockResolvedValue(info(overrides))
    render(<RemoteControlPage />)

    await screen.findByText(
      overrides.pairing_open === false ? 'Pairing window is closed' : 'Pairing window is open',
    )
    expect(
      screen.queryByRole('img', { name: 'Remote control pairing QR code' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('http://192.168.1.2:1420/pair/abc')).not.toBeInTheDocument()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  state: {
    preferences: {
      claudeFullscreen: false,
      cliPaths: {},
      customAgents: [],
      enabledAgents: {
        shell: true,
        wsl: true,
        claude: true,
        codex: true,
        copilot: true,
        cursor: true,
        antigravity: true,
        opencode: true,
        freebuff: true,
        mimo: true,
        kiro: true,
        kimi: true,
        grok: true,
        codewhale: true,
      },
      shellPath: null,
      spawnConcurrency: 4,
      terminalFontFamily: 'Cascadia Mono',
      terminalTheme: null,
      uiTheme: 'dark',
    },
    cliPaths: {},
    setAgentEnabled: vi.fn(),
    setCliPath: vi.fn(),
    setPreferences: vi.fn(),
  },
}))

vi.mock('../../../stores/projectsStore', () => ({
  SPAWN_CONCURRENCY_LIMITS: { min: 1, max: 8, step: 1 },
  useProjectsStore: (selector: (state: typeof store.state) => unknown) => selector(store.state),
}))

vi.mock('../../../stores/uiStore', () => ({
  useUiStore: (selector: (state: { pushToast: () => void; openModal_: () => void }) => unknown) =>
    selector({ pushToast: vi.fn(), openModal_: vi.fn() }),
}))

import { TerminalPage } from './TerminalPage'

describe('TerminalPage Claude renderer preference', () => {
  beforeEach(() => {
    store.state.setPreferences.mockReset()
    store.state.preferences.claudeFullscreen = false
  })

  it('starts unchecked, so Claude runs in the classic renderer', () => {
    render(<TerminalPage enabledCount={1} />)

    const toggle = screen.getByRole('checkbox', { name: /fullscreen renderer/i })
    expect((toggle as HTMLInputElement).checked).toBe(false)
  })

  it('stores the fullscreen choice the pane reads at spawn', () => {
    render(<TerminalPage enabledCount={1} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /fullscreen renderer/i }))

    expect(store.state.setPreferences).toHaveBeenCalledWith({ claudeFullscreen: true })
  })
})

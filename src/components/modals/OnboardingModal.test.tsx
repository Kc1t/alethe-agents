import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const mcp = {
    scope: 'global',
    repo: null,
    snapshots: [] as Array<Record<string, unknown>>,
    capabilities: { claude: { agent: 'claude' } },
    refresh: vi.fn(async () => undefined),
  }
  const notify = () => listeners.forEach((listener) => listener())
  return {
    listeners,
    mcp,
    notify,
    projects: {
      preferences: {
        onboardingDone: false,
        displayName: '',
        profileImageUrl: '',
        language: 'en',
        appIconTheme: 'default',
        enabledAgents: { claude: true, shell: true },
        enabledFeatures: {},
        uiTheme: 'dark',
        terminalTheme: 'dark',
      },
      setPreferences: vi.fn(),
      setLanguage: vi.fn(),
      setAgentEnabled: vi.fn(),
    },
    mcpUpsert: vi.fn(async () => undefined),
    cloudSyncStatus: vi.fn(async () => ({ configured: false, connected: false, login: null })),
    findCliLauncher: vi.fn(async () => null),
    agentCliVersion: vi.fn(async () => null),
    cloudSyncDeviceStart: vi.fn(),
    cloudSyncDeviceFinish: vi.fn(),
    cloudSyncPull: vi.fn(),
    cloudSyncPush: vi.fn(),
    openInBrowser: vi.fn(),
    setActiveView: vi.fn(),
  }
})

vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    (selector: (value: typeof state.projects) => unknown) => selector(state.projects),
    { getState: () => state.projects },
  ),
}))

vi.mock('../../stores/uiStore', () => ({
  useUiStore: { getState: () => ({ setActiveView: state.setActiveView }) },
}))

vi.mock('../../stores/mcpStore', async () => {
  const React = await import('react')
  return {
    useMcpStore: Object.assign(
      (selector: (value: typeof state.mcp) => unknown) =>
        React.useSyncExternalStore(
          (listener) => {
            state.listeners.add(listener)
            return () => state.listeners.delete(listener)
          },
          () => selector(state.mcp),
        ),
      { getState: () => state.mcp },
    ),
  }
})

vi.mock('../../lib/tauri', () => ({
  agentCliVersion: state.agentCliVersion,
  cloudSyncDeviceFinish: state.cloudSyncDeviceFinish,
  cloudSyncDeviceStart: state.cloudSyncDeviceStart,
  cloudSyncPull: state.cloudSyncPull,
  cloudSyncPush: state.cloudSyncPush,
  cloudSyncStatus: state.cloudSyncStatus,
  findCliLauncher: state.findCliLauncher,
  mcpUpsert: state.mcpUpsert,
  openInBrowser: state.openInBrowser,
}))

vi.mock('../../lib/agentVersions', () => ({ latestVersionFor: vi.fn(async () => null) }))
vi.mock('./onboarding/AgentsStep', () => ({
  AgentsStep: () => createElement('p', null, 'Agents panel'),
}))
vi.mock('./onboarding/UsageAccessStep', () => ({ UsageAccessStep: () => null }))
vi.mock('./onboarding/FeaturesStep', () => ({ FeaturesStep: () => null }))
vi.mock('./mcp/AddServerFlow', () => ({
  AddServerFlow: ({ onClose, onDone }: { onClose: () => void; onDone: () => void }) =>
    createPortal(
      createElement(
        'form',
        {
          onSubmit: async (event: React.FormEvent) => {
            event.preventDefault()
            await state.mcpUpsert('claude', 'global', null, { name: 'Test server' })
            state.mcp.snapshots = [
              {
                agent: 'claude',
                scope: 'global',
                sources: [{ parseError: null, writable: true }],
                servers: [
                  {
                    agent: 'claude',
                    scope: 'global',
                    sourceKind: 'user',
                    sourcePath: '/config',
                    managedByImport: null,
                    server: {
                      name: 'Test server',
                      transport: { kind: 'stdio', command: 'test', args: [], cwd: null },
                      env: {},
                      enabled: true,
                      timeouts: { startupSecs: null, toolSecs: null },
                      bearerTokenEnvVar: null,
                    },
                  },
                ],
              },
            ]
            state.notify()
            onDone()
            onClose()
          },
        },
        createElement('textarea', { 'aria-label': 'Server details' }),
        createElement('button', { type: 'submit' }, 'Save server'),
      ),
      document.body,
    ),
}))

import { OnboardingModal } from './OnboardingModal'

beforeEach(() => {
  state.projects.preferences.onboardingDone = false
  state.projects.preferences.displayName = ''
  state.mcp.snapshots = [
    {
      agent: 'claude',
      scope: 'global',
      sources: [{ parseError: null, writable: true }],
      servers: [],
    },
  ]
  state.mcp.refresh.mockClear()
  state.mcp.refresh.mockImplementation(async () => undefined)
  state.mcpUpsert.mockClear()
  state.cloudSyncStatus.mockResolvedValue({ configured: false, connected: false, login: null })
})

afterEach(cleanup)

async function reachMcpStep() {
  render(<OnboardingModal />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Vitor' } })
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  await screen.findByText('Agents panel')
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  await screen.findByRole('heading', { name: 'Add MCP servers' })
}

describe('OnboardingModal MCP step', () => {
  it('adds a server from the nested flow and lists it in onboarding', async () => {
    await reachMcpStep()
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save server' }))

    expect(await screen.findByText('Test server')).toBeInTheDocument()
    expect(state.mcpUpsert).toHaveBeenCalledWith('claude', 'global', null, { name: 'Test server' })
  })

  it('skips with no MCP changes', async () => {
    await reachMcpStep()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(
      await screen.findByRole('heading', { name: 'Show your usage limits?' }),
    ).toBeInTheDocument()
    expect(state.mcpUpsert).not.toHaveBeenCalled()
  })

  it('navigates back and forward between Agents, MCP, and Usage', async () => {
    await reachMcpStep()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Agents panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    await screen.findByRole('heading', { name: 'Add MCP servers' })
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(
      await screen.findByRole('heading', { name: 'Show your usage limits?' }),
    ).toBeInTheDocument()
    expect(state.mcpUpsert).not.toHaveBeenCalled()
  })

  it('does not advance when Enter is pressed in the nested flow', async () => {
    await reachMcpStep()
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    const details = await screen.findByRole('textbox', { name: 'Server details' })
    fireEvent.keyDown(details, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Add MCP servers' })).toBeInTheDocument(),
    )
  })

  it('preserves Enter activation on Add server', async () => {
    await reachMcpStep()
    const addServer = screen.getByRole('button', { name: 'Add server' })
    addServer.focus()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    addServer.dispatchEvent(enter)

    expect(enter.defaultPrevented).toBe(false)
    expect(screen.getByRole('heading', { name: 'Add MCP servers' })).toBeInTheDocument()

    fireEvent.click(addServer)
    expect(await screen.findByRole('textbox', { name: 'Server details' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Add MCP servers' })).toBeInTheDocument()
  })

  it('advances from the name input when Enter is pressed', async () => {
    render(<OnboardingModal />)
    const name = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'Vitor' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    expect(await screen.findByText('Agents panel')).toBeInTheDocument()
  })
})

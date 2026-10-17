import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginRuntimeEntry } from '../../lib/plugins/types'

const mocks = vi.hoisted(() => ({
  uninstall: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  installed: [] as PluginRuntimeEntry[],
  enable: vi.fn(),
}))

vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('../../lib/plugins', () => ({
  PLUGIN_API_VERSION: 1,
  usePlugins: () => mocks.installed,
  refreshLocalPlugins: mocks.refresh,
  setPluginEnabled: mocks.enable,
}))
vi.mock('../../lib/tauri', () => ({
  pluginUninstall: mocks.uninstall,
  pluginCatalogOpen: vi.fn(),
  pluginInstallFromCatalog: vi.fn(),
}))
vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector: (state: unknown) => unknown) => selector({ pushToast: mocks.toast }),
}))
vi.mock('./useCatalog', () => ({
  useCatalog: () => ({ entries: [], loading: false, stale: false, reload: vi.fn() }),
}))
vi.mock('../modals/preferences/pluginCapabilities', () => ({ CapabilityList: () => null }))

import { PluginsSidebar } from './index'

describe('plugin market profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.installed = [
      {
        manifest: {
          id: 'test-plugin',
          name: 'Test plugin',
          description: 'A local plugin',
          version: '1.0.0',
          kind: 'ui',
          apiVersion: 1,
          capabilities: [],
          spec: {},
        },
        source: 'local',
        enabled: true,
      },
    ] as PluginRuntimeEntry[]
    mocks.uninstall.mockResolvedValue(undefined)
    mocks.refresh.mockResolvedValue(undefined)
  })

  it('opens a modal without a project or grid pane and uninstalls after confirmation', async () => {
    render(<PluginsSidebar />)
    fireEvent.click(screen.getByRole('button', { name: /Test plugin/ }))
    const dialog = screen.getByRole('dialog', { name: 'Test plugin' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'prefs.pluginsUninstall' }))
    expect(mocks.uninstall).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'prefs.pluginsUninstallConfirm' }))
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith('test-plugin'))
    expect(mocks.refresh).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the profile open and reports uninstall failures', async () => {
    mocks.uninstall.mockRejectedValue(new Error('remove failed'))
    render(<PluginsSidebar />)
    fireEvent.click(screen.getByRole('button', { name: /Test plugin/ }))
    fireEvent.click(screen.getByRole('button', { name: 'prefs.pluginsUninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'prefs.pluginsUninstallConfirm' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('offers disable instead of uninstall for bundled plugins', () => {
    mocks.installed = [{ ...mocks.installed[0], source: 'bundled' }]
    render(<PluginsSidebar />)
    fireEvent.click(screen.getByRole('button', { name: /Test plugin/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'pluginPane.disable' })).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: 'prefs.pluginsUninstall' }),
    ).not.toBeInTheDocument()
  })

  it('combines filters with search and restores the list when filters are cleared', () => {
    render(<PluginsSidebar />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unmatched query' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'pluginsTab.filterStatus' }), {
      target: { value: 'disabled' },
    })
    expect(screen.queryByRole('button', { name: /Test plugin/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'pluginsTab.clearFilters' }))
    expect(screen.getByRole('button', { name: /Test plugin/ })).toBeInTheDocument()
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'pluginsTab.filterStatus' })).toHaveValue('all')
  })
})

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createWebPane = vi.fn()
const pushToast = vi.fn()
let emit: ((page: unknown) => void) | null = null
const unlisten = vi.fn()

vi.mock('../lib/tauri', () => ({
  browserPaneObserve: vi.fn(async () => {}),
  listenBrowserTargetOpened: vi.fn(async (handler: (page: unknown) => void) => {
    emit = handler
    return unlisten
  }),
}))

vi.mock('../lib/i18n', () => ({
  getLocale: () => 'en',
  translate: (_locale: string, key: string, params?: Record<string, string>) =>
    params?.page ? `${key}:${params.page}` : key,
}))

vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: { getState: () => ({ activeProjectId: 'proj-1', createWebPane }) },
}))

vi.mock('../stores/uiStore', () => ({
  useUiStore: { getState: () => ({ pushToast }) },
}))

const { useAgentBrowserOffers } = await import('./useAgentBrowserOffers')

const page = { targetId: 'T7', url: 'https://example.test/docs', title: 'Docs' }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  createWebPane.mockClear()
  pushToast.mockClear()
  unlisten.mockClear()
  emit = null
})

describe('useAgentBrowserOffers', () => {
  it('offers rather than opening a pane on its own', async () => {
    renderHook(() => useAgentBrowserOffers(true))
    await flush()
    emit?.(page)

    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(
      createWebPane,
      'a page appearing must not take over the layout by itself',
    ).not.toHaveBeenCalled()
  })

  it('shows the page in the pane that already exists once accepted', async () => {
    renderHook(() => useAgentBrowserOffers(true))
    await flush()
    emit?.(page)

    pushToast.mock.calls[0]![0].actions[0].run()

    expect(createWebPane).toHaveBeenCalledWith('proj-1', {
      url: 'https://example.test/docs',
      name: 'Docs',
      engine: 'cdp',
      watchTargetId: 'T7',
    })
  })

  it('names an untitled page by its host', async () => {
    renderHook(() => useAgentBrowserOffers(true))
    await flush()
    emit?.({ ...page, title: '   ' })

    expect(pushToast.mock.calls[0]![0].body).toContain('example.test')
  })

  it('offers leaving it in the background as a real choice', async () => {
    renderHook(() => useAgentBrowserOffers(true))
    await flush()
    emit?.(page)

    const actions = pushToast.mock.calls[0]![0].actions
    expect(actions, 'the reader must be able to say no without ignoring the toast').toHaveLength(2)
    actions[1].run()
    expect(createWebPane, 'declining must not create anything').not.toHaveBeenCalled()
  })

  it('stays silent while the feature is off', async () => {
    renderHook(() => useAgentBrowserOffers(false))
    await flush()

    expect(emit, 'nothing should be listening at all').toBeNull()
    expect(pushToast).not.toHaveBeenCalled()
  })
})

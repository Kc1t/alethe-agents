import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  label: 'main',
  render: vi.fn(),
  initPluginHost: vi.fn(async () => undefined),
  setProjectsReadOnly: vi.fn(),
}))

vi.mock('./bootstrap', () => ({}))
vi.mock('./styles/reset.css', () => ({}))
vi.mock('./styles/theme.css', () => ({}))
vi.mock('./styles/visual-clean.css', () => ({}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: mocks.label }),
}))
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render: mocks.render }) } }))
vi.mock('./App', () => ({ default: function App() {} }))
vi.mock('./components/VoiceHud', () => ({ VoiceHud: function VoiceHud() {} }))
vi.mock('./OrchestrationWindow', () => ({
  OrchestrationWindow: function OrchestrationWindow() {},
}))
vi.mock('./lib/plugins', () => ({ initPluginHost: mocks.initPluginHost }))
vi.mock('./lib/tauri', () => ({ recordFrontendError: vi.fn() }))
vi.mock('./lib/themeTokens', () => ({ watchPluginThemeStyles: vi.fn() }))
vi.mock('./stores/projectsStore', () => ({ setProjectsReadOnly: mocks.setProjectsReadOnly }))

async function boot(label: string): Promise<string> {
  mocks.label = label
  vi.resetModules()
  await import('./main')
  const tree = mocks.render.mock.calls[0][0] as { props: { children: { type: { name: string } } } }
  return tree.props.children.type.name
}

describe('window entry', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    vi.clearAllMocks()
  })

  it('renders only the HUD in the voice HUD window, read-only and without plugins', async () => {
    expect(await boot('voice-hud')).toBe('VoiceHud')
    expect(mocks.setProjectsReadOnly).toHaveBeenCalledWith(true)
    expect(mocks.initPluginHost).not.toHaveBeenCalled()
  })

  it('runs the app shell and hosts plugins in the main window', async () => {
    expect(await boot('main')).toBe('App')
    expect(mocks.setProjectsReadOnly).not.toHaveBeenCalled()
    expect(mocks.initPluginHost).toHaveBeenCalledTimes(1)
  })
})

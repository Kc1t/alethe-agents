import { describe, expect, it } from 'vitest'

import { AGENT_RUNTIME_ADAPTERS, preparePtyRuntimeLaunch } from './agentRuntimeAdapter'

describe('preparePtyRuntimeLaunch', () => {
  it('full runtime profile preserves arguments and environment', () => {
    expect(preparePtyRuntimeLaunch('claude', 'full', ['--verbose'], { EXAMPLE: '1' })).toEqual({
      args: ['--verbose'],
      env: { EXAMPLE: '1' },
    })
  })

  it('lean Claude profile limits startup fan-out without disabling configured tools', () => {
    const launch = preparePtyRuntimeLaunch('claude', 'lean')
    expect(launch.env?.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toBe('4')
    expect(launch.env?.MCP_SERVER_CONNECTION_BATCH_SIZE).toBe('1')
    expect(launch.args.includes('--safe-mode')).toBe(false)
  })

  it('diagnostic Claude profile uses safe mode once', () => {
    const launch = preparePtyRuntimeLaunch('claude', 'diagnostic', ['--safe-mode'])
    expect(launch.args).toEqual(['--safe-mode'])
  })
})

describe('AGENT_RUNTIME_ADAPTERS', () => {
  it('runs Hermes through the stable PTY adapter', () => {
    const pty = AGENT_RUNTIME_ADAPTERS.find((adapter) => adapter.id === 'pty')
    expect(pty?.agents).toContain('hermes')
  })

  it('native adapters stay explicitly experimental and unavailable', () => {
    const native = AGENT_RUNTIME_ADAPTERS.filter((adapter) => adapter.id !== 'pty')
    expect(native.every((adapter) => adapter.experimental && !adapter.available)).toBe(true)
  })
})

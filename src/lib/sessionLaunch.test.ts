import { describe, expect, it } from 'vitest'

import { buildAgentLaunch } from './sessionLaunch'

describe('buildAgentLaunch', () => {
  it('new Claude panes receive distinct deterministic session ids', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const first = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[0],
    )
    const second = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[1],
    )

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.args).toEqual(['--session-id', ids[0], '--dangerously-skip-permissions'])
    expect(second.args).toEqual(['--session-id', ids[1], '--dangerously-skip-permissions'])
  })

  it('Claude resumes only the session assigned to its pane', () => {
    const launch = buildAgentLaunch(
      'claude',
      ['--continue', '--resume', 'stale', '--session-id', 'stale-too', '--model', 'sonnet'],
      'pane-session',
    )

    expect(launch.args).toEqual(['--resume', 'pane-session', '--model', 'sonnet'])
    expect(launch.createdSession).toBe(false)
  })

  it('Codex without a known id starts a new chat instead of resuming last', () => {
    const launch = buildAgentLaunch('codex', ['resume', '--last', '--search'])
    expect(launch.args).toEqual(['--search'])
  })

  it('Codex and OpenCode use their pane-specific resume syntax', () => {
    expect(buildAgentLaunch('codex', ['resume', 'old', '--search'], 'codex-pane').args).toEqual([
      'resume',
      'codex-pane',
      '--search',
    ])
    expect(
      buildAgentLaunch('opencode', ['--continue', '--session', 'old', '--model', 'x'], 'open-pane')
        .args,
    ).toEqual(['--session', 'open-pane', '--model', 'x'])
  })

  it('Hermes starts clean and resumes with its native session flag', () => {
    expect(
      buildAgentLaunch('hermes', [
        '-c',
        'stale-name',
        '--resume=stale-id',
        '--cli',
        '--yolo',
      ]).args,
    ).toEqual(['--tui', '--yolo'])
    expect(
      buildAgentLaunch(
        'hermes',
        ['--continue', 'old-name', '--resume', 'stale-id', '--tui', '--yolo'],
        'hermes-pane',
      ).args,
    ).toEqual(['--tui', '--resume', 'hermes-pane', '--yolo'])
  })

  it('Antigravity keeps agy flags and uses its pane-specific conversation', () => {
    expect(
      buildAgentLaunch(
        'antigravity',
        ['--continue', '--conversation', 'old', '--dangerously-skip-permissions'],
        'agy-pane',
      ).args,
    ).toEqual(['--conversation', 'agy-pane', '--dangerously-skip-permissions'])
  })
})

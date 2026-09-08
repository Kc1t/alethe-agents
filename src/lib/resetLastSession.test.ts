import { describe, expect, it } from 'vitest'

import { buildResumeArgs, pickSessionId } from './resetLastSession'

describe('pickSessionId', () => {
  const sessions = [
    { id: 'a', modified_at_ms: 100 },
    { id: 'b', modified_at_ms: 300 },
    { id: 'c', modified_at_ms: 200 },
  ]

  it('picks the most recent session when nothing is excluded', () => {
    expect(pickSessionId(sessions, {})).toBe('b')
  })

  it('excludes the currently running session id', () => {
    expect(pickSessionId(sessions, { id: 'b' })).toBe('c')
  })

  // Cenário real: o resume falhou, a CLI já criou uma sessão nova vazia (a mais
  // recente no disco) — sem isso, "resetar sessão" reabriria a mesma conversa vazia.
  it('prefers sessions older than the current spawn over a freshly created empty one', () => {
    const withFreshEmpty = [...sessions, { id: 'fresh-empty', modified_at_ms: 500 }]
    expect(pickSessionId(withFreshEmpty, { id: 'fresh-empty', before: 400 })).toBe('b')
  })

  it('falls back to all candidates when none are older than the spawn timestamp', () => {
    expect(pickSessionId(sessions, { before: 50 })).toBe('b')
  })

  it('returns null when there are no candidates left', () => {
    expect(pickSessionId([{ id: 'only', modified_at_ms: 1 }], { id: 'only' })).toBeNull()
    expect(pickSessionId([], {})).toBeNull()
  })
})

describe('buildResumeArgs', () => {
  it('claude: resumes a specific session and strips stale resume flags', () => {
    expect(
      buildResumeArgs('claude', ['--resume', 'stale', '--continue', '--model', 'sonnet'], 'new-id'),
    ).toEqual(['--resume', 'new-id', '--model', 'sonnet'])
  })

  it('claude: falls back to --continue when no session id is known', () => {
    expect(buildResumeArgs('claude', ['--model', 'sonnet'], null)).toEqual([
      '--continue',
      '--model',
      'sonnet',
    ])
  })

  it('codex: replaces a resume <id>/--last subcommand with the chosen session', () => {
    expect(buildResumeArgs('codex', ['resume', 'stale', '--search'], 'new-id')).toEqual([
      'resume',
      'new-id',
      '--search',
    ])
    expect(buildResumeArgs('codex', ['resume', '--last'], null)).toEqual(['resume', '--last'])
  })

  it('codex: prefixes a plain arg list with the resume subcommand', () => {
    expect(buildResumeArgs('codex', ['--search'], 'new-id')).toEqual([
      'resume',
      'new-id',
      '--search',
    ])
  })

  it('antigravity: resumes via --conversation and strips old continue flags', () => {
    expect(buildResumeArgs('antigravity', ['--conversation', 'stale', '-c'], 'new-id')).toEqual([
      '--conversation',
      'new-id',
    ])
    expect(buildResumeArgs('antigravity', [], null)).toEqual(['--continue'])
  })

  it('opencode: resumes via --session and strips --resume/--continue', () => {
    expect(
      buildResumeArgs('opencode', ['--session', 'stale', '--continue', '--model', 'x'], 'new-id'),
    ).toEqual(['--session', 'new-id', '--model', 'x'])
    expect(buildResumeArgs('opencode', ['--model', 'x'], null)).toEqual([
      '--continue',
      '--model',
      'x',
    ])
  })
})

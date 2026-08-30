import { describe, expect, it } from 'vitest'

import { buildGhosttyCommand } from './ghosttyCommand'

describe('buildGhosttyCommand', () => {
  it('shell não tem comando (abre o shell de login)', () => {
    expect(buildGhosttyCommand('shell')).toBeUndefined()
    expect(buildGhosttyCommand('shell', ['--whatever'])).toBeUndefined()
  })

  it('agente vira a linha de comando', () => {
    expect(buildGhosttyCommand('claude')).toBe('claude')
    expect(buildGhosttyCommand('codex')).toBe('codex')
    expect(buildGhosttyCommand('opencode')).toBe('opencode')
    expect(buildGhosttyCommand('antigravity')).toBe('agy')
    expect(buildGhosttyCommand('cursor')).toBe('cursor-agent')
  })

  it('inclui extraArgs simples sem aspas', () => {
    expect(buildGhosttyCommand('claude', ['--dangerously-skip-permissions'])).toBe(
      'claude --dangerously-skip-permissions',
    )
    expect(buildGhosttyCommand('antigravity', ['--dangerously-skip-permissions'])).toBe(
      'agy --dangerously-skip-permissions',
    )
    expect(buildGhosttyCommand('cursor', ['--force'])).toBe('cursor-agent --force')
  })

  it('cita args com espaços ou caracteres perigosos', () => {
    expect(buildGhosttyCommand('codex', ['--prompt', 'hello world'])).toBe(
      "codex --prompt 'hello world'",
    )
  })

  it('escapa aspas simples internas', () => {
    expect(buildGhosttyCommand('claude', ["it's"])).toBe("claude 'it'\\''s'")
  })
})

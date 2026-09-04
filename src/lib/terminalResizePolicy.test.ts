import { describe, expect, it } from 'vitest'

import {
  createTerminalResizePolicy,
  OPENCODE_MIN_SAFE_COLUMNS,
  stabilizeTerminalGrid,
} from './terminalResizePolicy'

describe('stabilizeTerminalGrid', () => {
  it('uses a horizontal viewport instead of sending extreme widths to OpenCode', () => {
    expect(stabilizeTerminalGrid('opencode', 17, 42)).toEqual({
      cols: OPENCODE_MIN_SAFE_COLUMNS,
      rows: 42,
      horizontalViewport: true,
    })
  })

  it('does not change a usable OpenCode grid', () => {
    expect(stabilizeTerminalGrid('opencode', 90, 31)).toEqual({
      cols: 90,
      rows: 31,
      horizontalViewport: false,
    })
  })

  it('does not impose a minimum on shells or other agents', () => {
    expect(stabilizeTerminalGrid('shell', 17, 9)).toEqual({
      cols: 17,
      rows: 9,
      horizontalViewport: false,
    })
    expect(stabilizeTerminalGrid('antigravity', 12, 7)).toEqual({
      cols: 12,
      rows: 7,
      horizontalViewport: false,
    })
  })
})

describe('createTerminalResizePolicy', () => {
  it('pins the Linux OpenCode grid while the pane viewport continues changing', () => {
    const policy = createTerminalResizePolicy('opencode', true)

    expect(policy.resolve(82, 34)).toEqual({ cols: 82, rows: 34, horizontalViewport: false })
    expect(policy.resolve(21, 48)).toEqual({ cols: 82, rows: 34, horizontalViewport: true })
    expect(policy.resolve(120, 60)).toEqual({ cols: 82, rows: 34, horizontalViewport: false })
  })

  it('opens a horizontal viewport when the first OpenCode measurement is below its safe grid', () => {
    const policy = createTerminalResizePolicy('opencode', true)

    expect(policy.resolve(22, 34)).toEqual({
      cols: OPENCODE_MIN_SAFE_COLUMNS,
      rows: 34,
      horizontalViewport: true,
    })
  })

  it('allows an authoritative shared PTY grid to replace the pinned grid', () => {
    const policy = createTerminalResizePolicy('opencode', true)
    policy.resolve(80, 30)

    expect(policy.resolve(96, 40, true)).toEqual({
      cols: 96,
      rows: 40,
      horizontalViewport: false,
    })
    expect(policy.resolve(20, 20)).toEqual({ cols: 96, rows: 40, horizontalViewport: true })
  })

  it('pins another Linux TUI agent without imposing the OpenCode minimum', () => {
    const policy = createTerminalResizePolicy('antigravity', true)

    expect(policy.resolve(37, 30)).toEqual({ cols: 37, rows: 30, horizontalViewport: false })
    expect(policy.resolve(16, 12)).toEqual({ cols: 37, rows: 30, horizontalViewport: true })
  })

  it('keeps native resizing on Windows and for other commands', () => {
    const windowsOpenCode = createTerminalResizePolicy('opencode', false)
    const linuxShell = createTerminalResizePolicy('shell', false)

    expect(windowsOpenCode.resolve(24, 12)).toEqual({
      cols: 24,
      rows: 12,
      horizontalViewport: false,
    })
    expect(linuxShell.resolve(19, 8)).toEqual({
      cols: 19,
      rows: 8,
      horizontalViewport: false,
    })
  })
})

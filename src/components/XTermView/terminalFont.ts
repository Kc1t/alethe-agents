import { DEFAULT_TERMINAL_FONT_FAMILY } from '../../lib/types'

export const TERMINAL_FONT_SIZE = 14

export const TERMINAL_FONT_FAMILY = [
  '"Caskaydia Cove Nerd Font Mono"',
  '"Alethe Terminal Symbols"',
  '"Cascadia Mono"',
  'Consolas',
  '"DejaVu Sans Mono"',
  '"Noto Sans Mono"',
  '"Liberation Mono"',
  'monospace',
].join(', ')

const TERMINAL_FONT_FACES = [
  `400 ${TERMINAL_FONT_SIZE}px "Caskaydia Cove Nerd Font Mono"`,
  `700 ${TERMINAL_FONT_SIZE}px "Caskaydia Cove Nerd Font Mono"`,
  `400 ${TERMINAL_FONT_SIZE}px "Alethe Terminal Symbols"`,
]

export function terminalFontsReady(): boolean {
  if (!('fonts' in document)) return true
  return TERMINAL_FONT_FACES.every((face) => document.fonts.check(face))
}

export async function loadTerminalFonts(): Promise<void> {
  await Promise.all(TERMINAL_FONT_FACES.map((face) => document.fonts.load(face).catch(() => [])))
}

export function resolveTerminalFontFamily(preference: string | undefined): string {
  const chosen = preference?.trim()
  if (!chosen || chosen === DEFAULT_TERMINAL_FONT_FAMILY) return TERMINAL_FONT_FAMILY
  return `${chosen}, ${TERMINAL_FONT_FAMILY}`
}

// xterm only re-measures cells when the option value changes, so alternate two equivalent stacks
export function remeasuredFontFamily(current: string | undefined, family: string): string {
  return current === family ? `${family} ` : family
}

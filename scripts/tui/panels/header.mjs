import { Box, Text } from 'ink'
import React from 'react'

const h = React.createElement

/**
 * The wordmark, in half-block glyphs.
 *
 * Two rows rather than a tall ASCII banner: the screen's job is to show state, and a logo that eats
 * a fifth of the terminal is decoration charging rent. It also degrades gracefully — a font without
 * these blocks still renders something legible, unlike a banner built from slashes.
 */
const LOGO = ['▄▀█ █░░ █▀▀ ▀█▀ █░█ █▀▀', '█▀█ █▄▄ ██▄ ░█░ █▀█ ██▄']

/** Printable width of the wordmark, used to centre it. */
const LOGO_WIDTH = LOGO[0].length

/**
 * A narrow terminal drops the wordmark rather than wrapping it into rubble.
 *
 * The threshold leaves room for the context line on either side; below it the header falls back to
 * plain text, which is still a header.
 */
const MIN_WIDTH_FOR_LOGO = LOGO_WIDTH + 34

export function Header({ branch, width, subtitle }) {
  const context = [branch, subtitle].filter(Boolean).join('  ·  ')

  if (width < MIN_WIDTH_FOR_LOGO) {
    return h(
      Box,
      { width, paddingX: 1 },
      h(Text, { bold: true, color: 'cyan' }, 'alethe'),
      context ? h(Text, { color: 'gray', dimColor: true }, `  ${context}`) : null,
    )
  }

  const left = Math.max(0, Math.floor((width - LOGO_WIDTH) / 2))
  return h(
    Box,
    { flexDirection: 'column', width },
    ...LOGO.map((row, index) =>
      h(Text, { key: index, color: 'cyan' }, `${' '.repeat(left)}${row}`),
    ),
    context
      ? h(
          Text,
          { color: 'gray', dimColor: true },
          `${' '.repeat(Math.max(0, Math.floor((width - context.length) / 2)))}${context}`,
        )
      : null,
  )
}

import { Box, Text } from 'ink'
import React from 'react'

const h = React.createElement

/**
 * The command rail. Persistent rather than a menu that appears and disappears, so the screen always
 * shows what can be done and what is already running.
 *
 * The hint for the selected command sits alone at the foot of the panel rather than under the row:
 * inline it pushed the running dot out of view, and under the row it wrapped into a second line that
 * shifted everything below it every time the cursor moved.
 */
export function CommandsPanel({ commands, cursor, running, focused }) {
  const selected = commands[cursor]
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      width: 24,
      overflow: 'hidden',
    },
    h(Text, { bold: focused, color: focused ? 'cyan' : 'white' }, 'COMANDOS'),
    ...commands.map((command, index) => {
      const handle = running.get(command.id)
      const alive = handle !== undefined && handle.exitCode === null
      const active = index === cursor
      return h(
        Box,
        { key: command.id },
        h(Text, { color: 'cyan' }, active ? '▌' : ' '),
        h(Text, { color: alive ? 'green' : undefined, bold: active }, ` ${command.label}`),
        alive ? h(Text, { color: 'green' }, ' ●') : null,
      )
    }),
    h(Box, { flexGrow: 1 }),
    selected
      ? h(Text, { color: 'gray', dimColor: true, wrap: 'truncate-end' }, selected.hint)
      : null,
  )
}

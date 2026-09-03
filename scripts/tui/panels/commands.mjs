import { Box, Text } from 'ink'
import React from 'react'

const h = React.createElement

/**
 * The command rail. Persistent rather than a menu that appears and disappears, so the screen always
 * shows what can be done and what is already running.
 */
export function CommandsPanel({ commands, cursor, running, focused }) {
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      width: 26,
    },
    h(Text, { bold: true }, 'COMANDOS'),
    commands.map((command, index) => {
      const handle = running.get(command.id)
      const alive = handle !== undefined && handle.exitCode === null
      const selected = index === cursor
      return h(
        Box,
        { key: command.id, flexDirection: 'column' },
        h(
          Box,
          null,
          h(Text, { color: 'cyan' }, selected ? '▸ ' : '  '),
          h(
            Text,
            { inverse: selected && focused, color: alive ? 'green' : undefined },
            command.label,
          ),
          alive ? h(Text, { color: 'green' }, ' ●') : null,
        ),
        selected ? h(Text, { color: 'gray', wrap: 'truncate-end' }, `  ${command.hint}`) : null,
      )
    }),
    h(Box, { marginTop: 1 }, h(Text, { color: 'gray' }, 'enter inicia/para')),
  )
}

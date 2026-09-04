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
/**
 * Rows this panel needs: border, title, one per command, and the hint line.
 *
 * Exported because the layout has to reserve them. A Box too small for its children does not clip a
 * row cleanly — it draws them on top of each other, so two commands merge into one unreadable line
 * and a third looks like it does not exist. The layout computing this itself is how that happened.
 */
export function commandsPanelHeight(commands) {
  return 3 + commands.length + 1
}

export function CommandsPanel({ commands, cursor, running, focused, isUp }) {
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
      const owned = handle !== undefined && handle.exitCode === null
      const alive = isUp ? isUp(command) : owned
      const active = index === cursor
      return h(
        Box,
        { key: command.id },
        h(Text, { color: 'cyan' }, active ? '▌' : ' '),
        h(Text, { color: alive ? 'green' : undefined, bold: active }, ` ${command.label}`),
        // A hollow dot marks an instance this screen did not start. It can still be stopped and
        // restarted, but saying so is honest: the screen has no output from it to show.
        alive ? h(Text, { color: 'green' }, owned ? ' ●' : ' ○') : null,
      )
    }),
    // No spacer pushing the hint to the bottom: with the panel exactly tall enough for its rows,
    // a growing spacer competes with them for the same space.
    selected
      ? h(Text, { color: 'gray', dimColor: true, wrap: 'truncate-end' }, selected.hint)
      : null,
  )
}

import { Box, Text } from 'ink'
import React from 'react'

const h = React.createElement

/** Trims a command line to the part that identifies which checkout it came from. */
function shorten(commandLine, width) {
  if (!commandLine) return ''
  const collapsed = commandLine.replace(/\s+/g, ' ').trim()
  return collapsed.length <= width ? collapsed : `…${collapsed.slice(-(width - 1))}`
}

/**
 * Live state: which ports are taken, and by what.
 *
 * The holder's command line, not just the process name, because "node.exe" cannot tell two dev
 * servers apart — and the whole reason to look at this panel is to find out *which* stale one is
 * sitting on the port. That is also what makes killing it an informed decision.
 */
export function StatePanel({ ports, processes, focused, width }) {
  const cmdWidth = Math.max(20, width - 40)
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      flexGrow: 1,
    },
    h(
      Box,
      null,
      h(Text, { bold: true }, 'ESTADO'),
      focused ? h(Text, { color: 'gray' }, '   k mata a árvore do dono') : null,
    ),
    ports.length === 0
      ? h(Text, { color: 'gray' }, 'lendo portas…')
      : ports.map((entry) =>
          h(
            Box,
            { key: entry.port, flexDirection: 'column' },
            h(
              Box,
              null,
              // The cursor has to be visible: `k` kills whatever this row points at, and an
              // ambiguous selection there ends the wrong process.
              h(Text, { color: 'cyan' }, entry.selected && focused ? '▸ ' : '  '),
              h(Text, { color: 'gray', inverse: entry.selected && focused }, `${entry.port}`),
              h(Text, null, '  '),
              entry.free
                ? h(Text, { color: 'green' }, 'livre')
                : h(Text, { color: 'yellow' }, 'ocupada'),
              entry.label ? h(Text, { color: 'gray' }, `  ${entry.label}`) : null,
            ),
            ...entry.holders.map((holder) =>
              h(
                Text,
                { key: holder.pid, color: 'gray' },
                `      ${holder.name ?? '?'} ${holder.pid}  ${shorten(holder.commandLine, cmdWidth)}`,
              ),
            ),
          ),
        ),
    processes.length > 0
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          ...processes.map((handle) =>
            h(
              Text,
              { key: handle.id, color: handle.exitCode === null ? 'green' : 'red' },
              `${handle.id}  pid ${handle.pid ?? '?'}  ${
                handle.exitCode === null
                  ? `${Math.round((Date.now() - handle.startedAt) / 1000)}s`
                  : `saiu (${handle.exitCode})`
              }`,
            ),
          ),
          // The last line of a launcher's own output, which is where "Port already in use" and
          // "ready in 1.4s" both show up.
          ...processes
            .filter((handle) => handle.lines.length > 0)
            .map((handle) =>
              h(
                Text,
                { key: `${handle.id}-tail`, color: 'gray', wrap: 'truncate-end' },
                `      ${handle.lines[handle.lines.length - 1]}`,
              ),
            ),
        )
      : null,
  )
}

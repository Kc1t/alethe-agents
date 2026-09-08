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
 *
 * A free port is deliberately quiet. Rendering three green "livre" labels every second trains the
 * eye to skip the column, which is the opposite of what a status panel is for; only the taken ones
 * are coloured.
 */
export function StatePanel({ ports, processes, focused, width }) {
  const cmdWidth = Math.max(20, width - 42)
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      flexGrow: 1,
      overflow: 'hidden',
    },
    h(
      Box,
      null,
      h(Text, { bold: focused, color: focused ? 'cyan' : 'white' }, 'ESTADO'),
      focused ? h(Text, { color: 'gray', dimColor: true }, '   k mata a árvore do dono') : null,
    ),
    ports.length === 0
      ? h(Text, { color: 'gray', dimColor: true }, 'lendo portas…')
      : ports.map((entry) =>
          h(
            Box,
            { key: entry.port, flexDirection: 'column' },
            h(
              Box,
              null,
              // The cursor has to be visible: `k` kills whatever this row points at, and an
              // ambiguous selection there ends the wrong process.
              h(Text, { color: 'cyan' }, entry.selected && focused ? '▌' : ' '),
              h(Text, { bold: entry.selected && focused }, ` ${entry.port}  `),
              entry.free
                ? h(Text, { color: 'gray', dimColor: true }, 'livre  ')
                : h(Text, { color: 'yellow' }, 'em uso '),
              entry.label ? h(Text, { color: 'gray', dimColor: true }, ` ${entry.label}`) : null,
            ),
            ...entry.holders.map((holder) =>
              h(
                Text,
                { key: holder.pid, color: 'gray', wrap: 'truncate-end' },
                `      ${holder.name ?? '?'} ${holder.pid}  ${shorten(holder.commandLine, cmdWidth)}`,
              ),
            ),
          ),
        ),
    processes.length > 0
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          ...processes.flatMap((handle) => [
            h(
              Text,
              { key: handle.id, color: handle.exitCode === null ? 'green' : 'red' },
              ` ${handle.id}  ${
                handle.exitCode === null
                  ? `pid ${handle.pid ?? '?'}  ${Math.round((Date.now() - handle.startedAt) / 1000)}s`
                  : `saiu (${handle.exitCode})`
              }`,
            ),
            // The launcher's own last line, which is where "Port already in use" and "ready in
            // 1.4s" both turn up.
            handle.lines.length > 0
              ? h(
                  Text,
                  { key: `${handle.id}-tail`, color: 'gray', dimColor: true, wrap: 'truncate-end' },
                  `      ${handle.lines[handle.lines.length - 1]}`,
                )
              : null,
          ]),
        )
      : null,
  )
}

import { Box, Text, useApp, useInput, useStdout } from 'ink'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { runDoctor, summarize } from './actions/doctor.mjs'
import { COMMANDS, stop } from './actions/processes.mjs'
import { freePort, inspectPorts, waitForPortFree } from './actions/ports.mjs'
import { filterGestures, gesturesFrom } from './flow/parse.mjs'
import { defaultLogPath, followFile } from './flow/reader.mjs'
import { CommandsPanel, commandsPanelHeight } from './panels/commands.mjs'
import { FlowPanel } from './panels/flow.mjs'
import { Header } from './panels/header.mjs'
import { StatePanel } from './panels/state.mjs'

const h = React.createElement

const PANELS = ['commands', 'state', 'flow']
const PORT_POLL_MS = 2500
/** How much of the stream is kept in memory. Older gestures scroll out of reach, not out of file. */
const MAX_RECORDS = 4000

function Footer({ mode, filter }) {
  if (mode === 'filter') {
    return h(
      Text,
      null,
      h(Text, { color: 'yellow' }, ' filtro: '),
      h(Text, null, `${filter}▌`),
      h(Text, { color: 'gray' }, '  enter aplica · esc cancela'),
    )
  }
  if (mode === 'help') {
    return h(Text, { color: 'gray' }, ' ? fecha a ajuda')
  }
  return h(
    Text,
    { color: 'gray', dimColor: true },
    ' tab · enter · r reiniciar · d doctor · f problemas · e expandir · / filtrar · ? ajuda · q sair',
  )
}

function Help() {
  const rows = [
    ['tab', 'trocar de painel'],
    ['↑ ↓', 'mover no painel focado'],
    ['enter', 'comandos: abrir/fechar o app · fluxo: expandir o gesto'],
    ['r', 'reiniciar o app selecionado (espera a porta liberar antes de subir)'],
    ['/', 'filtrar o fluxo por texto'],
    ['c', 'prender no corr do gesto selecionado (de novo solta)'],
    ['f', 'mostrar só os gestos com problema'],
    ['e', 'expandir ou recolher todos os gestos'],
    ['x', 'limpar o fluxo na tela (não apaga o arquivo)'],
    ['d', 'doctor: diagnostica o runtime que estiver rodando; os veredictos caem no fluxo'],
    ['k', 'no painel de estado: matar a árvore do processo dono da porta'],
    ['q', 'sair, parando o que esta tela iniciou'],
  ]
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { bold: true }, 'AJUDA'),
    ...rows.map(([key, what]) =>
      h(Box, { key }, h(Text, { color: 'cyan' }, key.padEnd(8)), h(Text, null, what)),
    ),
  )
}

export function App({ branch, logPath }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = stdout?.columns ?? 100
  const height = stdout?.rows ?? 30

  const [panel, setPanel] = useState('commands')
  const [mode, setMode] = useState('normal')
  const [commandCursor, setCommandCursor] = useState(0)
  const [flowCursor, setFlowCursor] = useState(0)
  const [portCursor, setPortCursor] = useState(0)
  const [running, setRunning] = useState(new Map())
  const [ports, setPorts] = useState([])
  const [records, setRecords] = useState([])
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  const [pinned, setPinned] = useState(null)
  const [expanded, setExpanded] = useState(new Set())
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [notice, setNotice] = useState(null)

  const runningRef = useRef(running)
  runningRef.current = running

  // Each command's identifying port, resolved once — the dev port is derived from the checkout path
  // and reading it is async, which a render cannot be.
  const [commandPorts, setCommandPorts] = useState(new Map())
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const pairs = await Promise.all(
        COMMANDS.map(async (command) => [command.id, await command.port()]),
      )
      if (!cancelled) setCommandPorts(new Map(pairs))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Ports, polled. Nothing here mutates them; the panel only reports.
  useEffect(() => {
    let stopped = false
    const poll = async () => {
      const next = await inspectPorts()
      if (!stopped) setPorts(next)
    }
    void poll()
    const timer = setInterval(() => void poll(), PORT_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  // The decision stream.
  useEffect(() => {
    return followFile(logPath, (text) => {
      const parsed = gesturesFrom(text).flatMap((gesture) => gesture.records)
      if (parsed.length === 0) return
      setRecords((current) => {
        const next = [...current, ...parsed]
        return next.length > MAX_RECORDS ? next.slice(next.length - MAX_RECORDS) : next
      })
    })
  }, [logPath])

  // Re-tick so elapsed times in the state panel stay honest.
  const [, setBeat] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setBeat((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const gestures = useMemo(() => {
    const all = gesturesFrom(records.map((record) => JSON.stringify(record)).join('\n'))
    const byPin = pinned === null ? all : all.filter((gesture) => gesture.corr === pinned)
    // "Only problems" is the filter someone actually reaches for: a healthy session produces many
    // correct, uninteresting gestures, and hunting the one bad entry among them by eye is exactly
    // the work this panel exists to remove.
    const byProblem = onlyProblems
      ? byPin.filter((gesture) => gesture.missing.length > 0 || gesture.worstOutcome === 'failed')
      : byPin
    return filterGestures(byProblem, filter)
  }, [records, filter, pinned, onlyProblems])

  const stopAll = useCallback(() => {
    for (const handle of runningRef.current.values()) stop(handle)
  }, [])

  /**
   * Whether a command's app is up, whoever started it.
   *
   * A handle this screen owns is the easy case. The common one is an instance started from another
   * terminal — the screen could see it in the port panel and do nothing about it, which made
   * "close the app" mean "close the app *I* opened".
   */
  const isUp = useCallback(
    (command) => {
      const owned = running.get(command.id)
      if (owned && owned.exitCode === null) return true
      return ports.some((entry) => entry.port === commandPorts.get(command.id) && !entry.free)
    },
    [running, ports, commandPorts],
  )

  const startCommand = useCallback((command) => {
    setRunning((current) => new Map(current).set(command.id, command.start()))
    setNotice(`iniciando ${command.label}`)
  }, [])

  /** Stops the app, including one this screen did not start. */
  const stopCommand = useCallback(
    async (command) => {
      const owned = runningRef.current.get(command.id)
      if (owned && owned.exitCode === null) {
        stop(owned)
        setNotice(`parando ${command.label}`)
        return
      }
      const port = commandPorts.get(command.id)
      if (port === undefined) {
        setNotice(`${command.label} não está rodando`)
        return
      }
      setNotice(`parando ${command.label} na porta ${port}…`)
      const results = await freePort(port)
      const refused = results.find((result) => !result.killed)
      setNotice(refused ? `${command.label}: ${refused.reason}` : `${command.label} parado`)
      setPorts(await inspectPorts())
    },
    [commandPorts],
  )

  const toggleCommand = useCallback(() => {
    const command = COMMANDS[commandCursor]
    if (!command) return
    if (isUp(command)) void stopCommand(command)
    else startCommand(command)
  }, [commandCursor, isUp, stopCommand, startCommand])

  /**
   * Stop, wait for the port to actually free, start again.
   *
   * The wait is the whole point. Starting the instant the kill returns races the old process's
   * socket teardown, so the new instance either fails to bind or slides to a different port — and
   * then the screen reports a port nothing is serving.
   */
  const restartCommand = useCallback(async () => {
    const command = COMMANDS[commandCursor]
    if (!command) return
    const port = commandPorts.get(command.id)
    if (isUp(command)) {
      await stopCommand(command)
      if (port !== undefined) {
        setNotice(`reiniciando ${command.label}: esperando a porta ${port} liberar…`)
        const freed = await waitForPortFree(port)
        if (!freed) {
          setNotice(`${command.label}: a porta ${port} não liberou; não reiniciei`)
          return
        }
      }
    }
    startCommand(command)
    setNotice(`${command.label} reiniciado`)
  }, [commandCursor, commandPorts, isUp, stopCommand, startCommand])

  // The doctor runs in Rust, against whichever runtime is up. Its verdicts are decision records, so
  // they land in the flow panel below on their own — no panel of its own, and one vocabulary.
  const runDiagnosis = useCallback(async () => {
    setNotice('doctor: perguntando ao runtime…')
    const report = await runDoctor()
    setNotice(summarize(report))
  }, [])

  const killSelectedPort = useCallback(async () => {
    const entry = ports[portCursor]
    if (!entry || entry.holders.length === 0) {
      setNotice('nada para matar nessa porta')
      return
    }
    const { killTree } = await import('./actions/ports.mjs')
    const results = []
    for (const holder of entry.holders) {
      results.push(await killTree(holder.pid))
    }
    const refused = results.filter((result) => !result.killed)
    setNotice(
      refused.length === 0
        ? `porta ${entry.port} liberada`
        : `porta ${entry.port}: ${refused[0].reason}`,
    )
    setPorts(await inspectPorts())
  }, [ports, portCursor])

  useInput((input, key) => {
    if (mode === 'filter') {
      if (key.escape) {
        setDraft('')
        setMode('normal')
        return
      }
      if (key.return) {
        setFilter(draft)
        setMode('normal')
        return
      }
      if (key.backspace || key.delete) {
        setDraft((value) => value.slice(0, -1))
        return
      }
      if (input) setDraft((value) => value + input)
      return
    }

    if (mode === 'help') {
      if (input === '?' || key.escape || key.return) setMode('normal')
      return
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      stopAll()
      exit()
      return
    }
    if (input === '?') {
      setMode('help')
      return
    }
    if (key.tab) {
      setPanel((current) => PANELS[(PANELS.indexOf(current) + 1) % PANELS.length])
      return
    }
    if (input === '/') {
      setDraft(filter)
      setMode('filter')
      return
    }
    if (input === 'f') {
      setOnlyProblems((value) => !value)
      setFlowCursor(0)
      return
    }
    if (input === 'e') {
      // Expanding everything is how a short session is read end to end; collapsing everything is
      // how you get back to a list afterwards.
      setExpanded((current) =>
        current.size > 0 ? new Set() : new Set(gestures.map((gesture) => gesture.corr ?? '')),
      )
      return
    }
    if (input === 'x') {
      setRecords([])
      setNotice('fluxo limpo na tela (o arquivo continua intacto)')
      return
    }
    if (input === 'c') {
      const gesture = gestures[flowCursor]
      setPinned((current) => (current !== null ? null : (gesture?.corr ?? null)))
      return
    }

    if (input === 'd') {
      void runDiagnosis()
      return
    }

    if (input === 'r') {
      void restartCommand()
      return
    }

    if (panel === 'commands') {
      if (key.upArrow) setCommandCursor((value) => Math.max(0, value - 1))
      if (key.downArrow) setCommandCursor((value) => Math.min(COMMANDS.length - 1, value + 1))
      if (key.return) toggleCommand()
      return
    }
    if (panel === 'state') {
      if (key.upArrow) setPortCursor((value) => Math.max(0, value - 1))
      if (key.downArrow)
        setPortCursor((value) => Math.min(Math.max(0, ports.length - 1), value + 1))
      if (input === 'k') void killSelectedPort()
      return
    }
    if (panel === 'flow') {
      if (key.upArrow) setFlowCursor((value) => Math.max(0, value - 1))
      if (key.downArrow)
        setFlowCursor((value) => Math.min(Math.max(0, gestures.length - 1), value + 1))
      if (key.return) {
        const gesture = gestures[flowCursor]
        if (gesture) {
          setExpanded((current) => {
            const next = new Set(current)
            const id = gesture.corr ?? ''
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
      }
    }
  })

  // Whatever the screen started must not outlive it.
  useEffect(() => stopAll, [stopAll])

  const subtitle = [
    `${COMMANDS.filter((command) => running.get(command.id)?.exitCode === null).length} rodando`,
    `${gestures.length} no fluxo`,
  ].join('  ·  ')

  if (mode === 'help') {
    return h(
      Box,
      { flexDirection: 'column', width, height },
      h(Header, { branch, width, subtitle }),
      h(Help),
      h(Box, { flexGrow: 1 }),
      h(Footer, { mode }),
    )
  }

  // Sized to what it holds, so the flow panel gets every row left over instead of a fixed fraction
  // that left both halves half empty.
  const stateRows =
    ports.length +
    ports.reduce((total, entry) => total + entry.holders.length, 0) +
    running.size * 2
  // Both panels have to fit, not just the state one. Sizing this from the state panel alone left
  // the command rail one row short, and a Box too small for its children does not scroll or clip a
  // row cleanly — it draws them on top of each other, so `dev (debug)` and `web` became one
  // unreadable line and the third command looked like it did not exist.
  const commandRows = commandsPanelHeight(COMMANDS)
  const topHeight = Math.min(
    Math.max(6, stateRows + 3, commandRows),
    Math.max(commandRows, height - 12),
  )
  return h(
    Box,
    { flexDirection: 'column', width, height },
    h(Header, { branch, width, subtitle }),
    h(
      Box,
      { height: topHeight, flexShrink: 0 },
      h(CommandsPanel, {
        commands: COMMANDS,
        cursor: commandCursor,
        running,
        isUp,
        focused: panel === 'commands',
      }),
      h(StatePanel, {
        ports: ports.map((entry, index) => ({ ...entry, selected: index === portCursor })),
        processes: [...running.values()],
        focused: panel === 'state',
        width: width - 28,
      }),
    ),
    h(FlowPanel, {
      gestures,
      cursor: flowCursor,
      expanded,
      focused: panel === 'flow',
      filter,
      pinned,
      height: height - topHeight - 7,
      onlyProblems,
    }),
    notice ? h(Text, { color: 'cyan' }, ` ${notice}`) : null,
    h(Footer, { mode, filter: draft }),
  )
}

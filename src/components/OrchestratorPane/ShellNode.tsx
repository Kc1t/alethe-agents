import {
  type LucideIcon,
  Play,
  RotateCcw,
  Square,
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import type { MessageKey, TFunction } from '../../lib/i18n'
import type { GraphNode } from '../../lib/orchestratorGraph'
import { type BoardShell, type ShellControl, shellControls } from '../../lib/orchestratorShells'
import { type OrchestratorShell, orchestratorShellOutput } from '../../lib/tauri/orchestrator'
import styles from './ShellNode.module.css'

const TAIL_LINES = 1
const TAIL_POLL_MS = 2000

const CONTROL_ICON: Record<ShellControl, LucideIcon> = {
  stop: Square,
  restart: RotateCcw,
  play: Play,
  openTerminal: TerminalIcon,
  remove: Trash2,
}

const CONTROL_LABEL: Record<ShellControl, MessageKey> = {
  stop: 'orchestrator.shell.stop',
  restart: 'orchestrator.shell.restart',
  play: 'orchestrator.shell.play',
  openTerminal: 'orchestrator.shell.openTerminal',
  remove: 'orchestrator.shell.remove',
}

type BindNode = (id: string, element: HTMLElement | null) => void

type ShellNodeProps = {
  shell: BoardShell
  node: GraphNode
  selected: boolean
  /** A control is on its way; opening the terminal stays available meanwhile. */
  busy: boolean
  onOpen: (shell: OrchestratorShell) => void
  onControl: (shell: OrchestratorShell, control: ShellControl) => void
  bind: BindNode
  t: TFunction
}

/** The canvas card for a shell: same footprint as a worker node, connected to whoever opened it. */
export function ShellNode({ shell, node, selected, busy, onOpen, onControl, bind, t }: ShellNodeProps) {
  const [output, setOutput] = useState('')

  // A running shell is read every few seconds while its card is on screen; a finished one once.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void orchestratorShellOutput(shell.id, TAIL_LINES)
        .then((read) => {
          if (!cancelled) setOutput(read.output)
        })
        .catch(() => {})
    }
    load()
    const timer = shell.status === 'running' ? window.setInterval(load, TAIL_POLL_MS) : null
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
    }
  }, [shell.id, shell.status])

  const status =
    shell.status === 'running'
      ? t('orchestrator.shell.running')
      : shell.status === 'exited'
        ? t('orchestrator.shell.exited', { code: shell.exitCode ?? '—' })
        : t('orchestrator.shell.stopped')

  return (
    <article
      ref={(element) => bind(shell.id, element)}
      className={styles.node}
      style={{ left: node.x, top: node.y, width: node.width }}
      data-status={shell.status}
      data-selected={selected ? 'true' : undefined}
    >
      <div className={styles.controls}>
        {shellControls(shell.status).map((control) => {
          const Icon = CONTROL_ICON[control]
          const label = t(CONTROL_LABEL[control])
          return (
            <button
              key={control}
              type="button"
              className={styles.control}
              data-control={control}
              disabled={busy && control !== 'openTerminal'}
              title={label}
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onControl(shell, control)}
            >
              <Icon size={12} />
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className={styles.card}
        title={shell.command}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onOpen(shell)}
      >
        <span className={styles.head}>
          <span className={styles.dot} aria-hidden />
          <span className={styles.name}>{shell.name}</span>
          <span className={styles.status}>{status}</span>
        </span>
        <code className={styles.command}>{shell.command}</code>
        {output ? <span className={styles.output}>{output}</span> : null}
      </button>
    </article>
  )
}

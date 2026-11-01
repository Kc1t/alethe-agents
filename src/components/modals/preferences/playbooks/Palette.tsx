import {
  BatteryLow,
  Bot,
  ChevronsDown,
  Coins,
  Crosshair,
  DollarSign,
  Gauge,
  Layers,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Recycle,
  Search,
  ShieldCheck,
  TriangleAlert,
  User,
  Wallet,
  XCircle,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { MessageKey } from '../../../../lib/i18n'
import { usePlaybooks } from './context'
import styles from './Playbooks.module.css'

export type Block = {
  id: string
  kind: 'worker' | 'lead' | 'check' | 'condition'
  cond?: string
  icon: LucideIcon
  label: MessageKey
}

function blocks(providers: string[]): { steps: Block[]; conditions: Block[] } {
  const first = providers[0] ?? 'claude'
  const second = providers[1] ?? first
  return {
    steps: [
      { id: 'worker', kind: 'worker', icon: Bot, label: 'playbooks.block.worker' },
      { id: 'lead', kind: 'lead', icon: User, label: 'playbooks.block.lead' },
      { id: 'check', kind: 'check', icon: ShieldCheck, label: 'playbooks.block.check' },
    ],
    conditions: [
      {
        id: 'narrow',
        kind: 'condition',
        cond: 'narrow',
        icon: Crosshair,
        label: 'playbooks.block.narrow',
      },
      {
        id: 'research',
        kind: 'condition',
        cond: 'kind:research',
        icon: Search,
        label: 'playbooks.block.research',
      },
      { id: 'deep', kind: 'condition', cond: 'deep', icon: Layers, label: 'playbooks.block.deep' },
      {
        id: 'low',
        kind: 'condition',
        cond: `${first}-low`,
        icon: BatteryLow,
        label: 'playbooks.block.low',
      },
      {
        id: 'above',
        kind: 'condition',
        cond: `${first}-above:80`,
        icon: Gauge,
        label: 'playbooks.block.above',
      },
      {
        id: 'spare',
        kind: 'condition',
        cond: `${second}-spare`,
        icon: Recycle,
        label: 'playbooks.block.spare',
      },
      {
        id: 'allLow',
        kind: 'condition',
        cond: 'all-low',
        icon: TriangleAlert,
        label: 'playbooks.block.allLow',
      },
      {
        id: 'price',
        kind: 'condition',
        cond: 'price-above:5',
        icon: DollarSign,
        label: 'playbooks.block.price',
      },
      {
        id: 'spent',
        kind: 'condition',
        cond: 'spent-above:10',
        icon: Coins,
        label: 'playbooks.block.spent',
      },
      {
        id: 'budget',
        kind: 'condition',
        cond: 'budget-low',
        icon: Wallet,
        label: 'playbooks.block.budget',
      },
      {
        id: 'failed',
        kind: 'condition',
        cond: 'checks-failed',
        icon: XCircle,
        label: 'playbooks.block.failed',
      },
    ],
  }
}

type Dragging = { block: Block; x: number; y: number; sx: number; sy: number; moved: boolean }

export function Palette({
  open,
  onToggle,
  onDrop,
}: {
  open: boolean
  onToggle: () => void
  onDrop: (block: Block, clientX: number, clientY: number) => void
}) {
  const { s, t } = usePlaybooks()
  const [dragging, setDragging] = useState<Dragging | null>(null)
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging
  const suppress = useRef(false)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  const active = dragging !== null

  useEffect(() => {
    if (!active) return
    const move = (event: PointerEvent) => {
      const current = draggingRef.current
      if (!current) return
      const moved =
        current.moved || Math.hypot(event.clientX - current.sx, event.clientY - current.sy) > 4
      setDragging({ ...current, x: event.clientX, y: event.clientY, moved })
    }
    const up = (event: PointerEvent) => {
      const current = draggingRef.current
      setDragging(null)
      if (current?.moved) {
        suppress.current = true
        dropRef.current(current.block, event.clientX, event.clientY)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [active])

  const { steps, conditions } = blocks(s.providers)
  const GhostIcon = dragging?.block.icon ?? Bot
  const item = (block: Block) => {
    const Icon = block.icon
    return (
      <button
        key={block.id}
        type="button"
        className={styles.block}
        data-kind={block.kind}
        title={t('playbooks.blockHint')}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          suppress.current = false
          setDragging({
            block,
            x: event.clientX,
            y: event.clientY,
            sx: event.clientX,
            sy: event.clientY,
            moved: false,
          })
        }}
        onClick={() => {
          if (suppress.current) {
            suppress.current = false
            return
          }
          onDrop(block, Number.NaN, Number.NaN)
        }}
      >
        <Icon size={13} />
        <span>{t(block.label)}</span>
      </button>
    )
  }

  return (
    <>
      <div className={open ? styles.palette : `${styles.palette} ${styles.paletteClosed}`}>
        <button
          type="button"
          className={styles.paletteToggle}
          aria-expanded={open}
          aria-label={open ? t('playbooks.hideBlocks') : t('playbooks.showBlocks')}
          title={open ? t('playbooks.hideBlocks') : t('playbooks.showBlocks')}
          onClick={onToggle}
        >
          {open ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
          {open ? <span>{t('playbooks.blocks')}</span> : null}
        </button>
        {open ? (
          <div className={styles.paletteBody}>
            <span className={styles.paletteGroup}>
              <ChevronsDown size={11} />
              {t('playbooks.blockSteps')}
            </span>
            {steps.map(item)}
            <span className={styles.paletteGroup}>
              <ChevronsDown size={11} />
              {t('playbooks.blockConditions')}
            </span>
            {conditions.map(item)}
          </div>
        ) : null}
      </div>
      {dragging?.moved ? (
        <div className={styles.blockGhost} style={{ left: dragging.x + 8, top: dragging.y + 8 }}>
          <GhostIcon size={13} />
          {t(dragging.block.label)}
        </div>
      ) : null}
    </>
  )
}

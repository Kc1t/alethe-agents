import { LayoutGrid, Maximize2, Minus, Plus } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import type { MessageKey } from '../../../../lib/i18n'
import {
  connect,
  type DocNode,
  type DocPort,
  type FlowDoc,
  freshNodeId,
  freshPhaseId,
  nodeAt,
  nodeSize,
  OUT_PORTS,
  portPoint,
  removeEdge,
  removeNode,
} from '../../../../lib/playbooks/flowDoc'
import { type DocView, saveLayout, tidyDoc } from '../../../../lib/playbooks/flowView'
import {
  arrowHead,
  type DecisionNode,
  type EndNode,
  fitView,
  type Point2,
  type RoleNode,
  rounded,
  type View,
  zoomAt,
} from '../../../../lib/playbooks/graph'
import {
  COST_TOKEN,
  nextProvider,
  type PhaseUse,
  type PlaybookWorkflow,
} from '../../../../lib/playbooks/state'
import { usePlaybooks } from './context'
import { Decision, End, ghostParts, Role } from './FlowCanvas'
import { type Block, Palette } from './Palette'
import styles from './Playbooks.module.css'

const PALETTE_WIDTH = 190

export const edgeKey = (e: { from: string; port: DocPort; to: string }) =>
  `edge:${e.from}|${e.port}|${e.to}`

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'node'; id: string; ox: number; oy: number; sx: number; sy: number; moved: boolean }
  | { kind: 'link'; from: string; port: DocPort; x: number; y: number }

function ruleFor(
  cond: string,
  s: ReturnType<typeof usePlaybooks>['s'],
  provider: string,
): PhaseUse {
  if (COST_TOKEN.test(cond) || cond === 'budget-low') return { tier: 'cheap' }
  if (/-low$/.test(cond) || /-above:\d+$/.test(cond)) {
    const next = s.providers.find((id) => id !== provider)
    return next ? { provider: next } : { tier: 'cheap' }
  }
  if (/-spare$/.test(cond) || cond === 'deep' || cond.startsWith('checks-failed'))
    return { tier: 'strong' }
  return { tier: 'cheap' }
}

function edgePoints(from: DocNode, port: DocPort, to: DocNode, laneX: () => number): Point2[] {
  const p1 = portPoint(from, port)
  const { w, h } = nodeSize(to)
  const top: Point2 = [to.x + w / 2, to.y]
  const side = port === 'yes' || port === 'fail' ? 'right' : 'bottom'
  const fromCx = from.x + nodeSize(from).w / 2
  if (to.kind === 'end' && to.y > p1[1] && Math.abs(fromCx - top[0]) > 1) {
    const lane = laneX()
    const right: Point2 = [to.x + w, to.y + h / 2]
    return side === 'right'
      ? [p1, [lane, p1[1]], [lane, right[1]], right]
      : [p1, [p1[0], p1[1] + 26], [lane, p1[1] + 26], [lane, right[1]], right]
  }
  if (to.y >= p1[1] + 16) {
    if (side === 'right') {
      if (top[0] > p1[0] + 16) return [p1, [top[0], p1[1]], top]
      return [p1, [p1[0] + 18, p1[1]], [p1[0] + 18, top[1] - 34], [top[0], top[1] - 34], top]
    }
    if (Math.abs(p1[0] - top[0]) < 1) return [p1, top]
    return [p1, [p1[0], top[1] - 34], [top[0], top[1] - 34], top]
  }
  const left: Point2 = [to.x, to.y + h / 2]
  if (side === 'right' && to.x >= p1[0] + 16) {
    if (Math.abs(p1[1] - left[1]) < 1) return [p1, left]
    const mid = (p1[0] + left[0]) / 2
    return [p1, [mid, p1[1]], [mid, left[1]], left]
  }
  const corridor = Math.min(to.y, from.y) - 22
  const out = side === 'right' ? p1[0] + 18 : from.x + nodeSize(from).w + 18
  return side === 'right'
    ? [p1, [out, p1[1]], [out, corridor], [top[0], corridor], top]
    : [p1, [p1[0], p1[1] + 18], [out, p1[1] + 18], [out, corridor], [top[0], corridor], top]
}

function Start({ n, selected }: { n: DocNode; selected: boolean }) {
  const { t } = usePlaybooks()
  const { w, h } = nodeSize(n)
  return (
    <g className={styles.node} data-node={n.id}>
      <rect
        className={styles.shape}
        data-tone={selected ? 'selected' : 'border'}
        x={n.x}
        y={n.y}
        width={w}
        height={h}
        rx={h / 2}
        strokeWidth={1.3}
      />
      <text
        className={styles.svgMuted}
        x={n.x + w / 2}
        y={n.y + h / 2 + 4}
        fontSize={11.5}
        textAnchor="middle"
      >
        {t('playbooks.start')}
      </text>
    </g>
  )
}

export function NodeCanvas({
  wf,
  view: docView,
  pulse,
  reserved,
  onStructure,
}: {
  wf: PlaybookWorkflow
  view: DocView
  pulse: number
  reserved: boolean
  onStructure: () => void
}) {
  const { s, t, select, selectedId, redraw } = usePlaybooks()
  const doc = wf.doc as FlowDoc
  const gridId = `playbooks-grid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<View | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const drag = useRef<Drag | null>(null)
  const [link, setLink] = useState<{ from: string; port: DocPort; x: number; y: number } | null>(
    null,
  )
  const [panning, setPanning] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const extentRef = useRef(docView.nodes)
  extentRef.current = docView.nodes

  const fit = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const left = paletteOpen ? PALETTE_WIDTH : 0
    const shapes = extentRef.current
    if (rect.width > left && rect.height && shapes.length) {
      const next = fitView(
        { nodes: shapes, edges: [] },
        rect.width - left,
        rect.height,
        reserved ? rect.height * 0.45 : 0,
      )
      setView({ ...next, x: next.x + left })
    }
  }, [reserved, paletteOpen])

  useLayoutEffect(() => {
    fit()
    const svg = svgRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [fit, wf.id])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      const current = viewRef.current
      if (!current) return
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      setView(
        zoomAt(
          current,
          event.clientX - rect.left,
          event.clientY - rect.top,
          current.k * Math.exp(-event.deltaY * 0.0015),
        ),
      )
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const toWorld = (clientX: number, clientY: number): [number, number] | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    const current = viewRef.current
    if (!rect || !current) return null
    return [
      (clientX - rect.left - current.x) / current.k,
      (clientY - rect.top - current.y) / current.k,
    ]
  }

  const removeSelected = () => {
    if (!selectedId) return
    if (selectedId.startsWith('edge:')) {
      const [from, port, to] = selectedId.slice(5).split('|')
      removeEdge(doc, { from, port: port as DocPort, to })
    } else {
      const node = doc.nodes.find((n) => n.id === selectedId)
      if (!node || node.kind === 'start' || node.kind === 'end') return
      removeNode(doc, node.id)
    }
    select(null)
    onStructure()
  }

  const drop = (block: Block, clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const inside =
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    const point = inside
      ? toWorld(clientX, clientY)
      : toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (!point) return
    const [x, y] = point
    const ghost = docView.nodes.find(
      (n) => n.type === 'ghost' && x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h,
    )
    const owner = ghost?.type === 'ghost' ? doc.nodes.find((n) => n.id === ghost.parent) : undefined
    const target = inside ? (nodeAt(doc, x, y) ?? owner ?? null) : null
    if (block.cond && target?.kind === 'phase' && target.phase) {
      const phase = target.phase
      const provider =
        phase.provider && phase.provider !== 'auto' ? phase.provider : (s.providers[0] ?? 'claude')
      const use = ruleFor(block.cond, s, provider)
      if (use.provider && use.provider === provider)
        use.provider = nextProvider(s, provider, phase, null) ?? undefined
      phase.rules = [...(phase.rules ?? []), { if: block.cond, use }]
      select(target.id)
      onStructure()
      return
    }
    let node: DocNode
    if (block.kind === 'worker' || block.kind === 'lead') {
      const lead = block.kind === 'lead'
      const id = freshPhaseId(doc, lead ? 'lead' : 'step')
      node = {
        id: `phase:${id}`,
        kind: 'phase',
        x: 0,
        y: 0,
        phase: lead
          ? { id, role: 'you', who: 'lead', tier: 'strong' }
          : { id, role: 'worker', tier: 'cheap' },
      }
    } else if (block.kind === 'check')
      node = { id: freshNodeId(doc, 'gate'), kind: 'gate', x: 0, y: 0, check: 'Checks pass' }
    else node = { id: freshNodeId(doc, 'dec'), kind: 'decision', x: 0, y: 0, cond: block.cond }
    const { w, h } = nodeSize(node)
    node.x = Math.round((x - w / 2) / 10) * 10
    node.y = Math.round((y - h / 2) / 10) * 10
    const taken = (left: number) =>
      docView.nodes.some(
        (n) =>
          left < n.x + n.w + 16 &&
          left + w + 16 > n.x &&
          node.y < n.y + n.h + 16 &&
          node.y + h + 16 > n.y,
      )
    for (let step = 0; !inside && step < 40 && taken(node.x); step++) node.x += 40
    doc.nodes.push(node)
    select(node.id)
    onStructure()
  }

  const zoomBy = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || !view) return
    setView(zoomAt(view, rect.width / 2, rect.height / 2, view.k * factor))
  }

  const byDoc = new Map(doc.nodes.map((n) => [n.id, n]))
  const right = Math.max(...doc.nodes.map((n) => n.x + nodeSize(n).w))
  let lanes = 0
  const problemNodes = new Set((wf.problems ?? []).map((p) => p.node))
  const links: ReactNode[] = []
  const shapes: ReactNode[] = []
  docView.nodes.forEach((n) => {
    if (n.type === 'ghost') {
      const [ghostLink, card] = ghostParts(n, docView, s, t)
      links.push(ghostLink)
      shapes.push(card)
    }
  })
  doc.nodes.forEach((n) => {
    const shown = docView.byId[n.id]
    if (n.kind === 'start') shapes.push(<Start key={n.id} n={n} selected={selectedId === n.id} />)
    else if (shown?.type === 'role')
      shapes.push(<Role key={n.id} n={shown as RoleNode} graph={docView} />)
    else if (shown?.type === 'decision')
      shapes.push(<Decision key={n.id} n={shown as DecisionNode} graph={docView} />)
    else if (shown?.type === 'end')
      shapes.push(<End key={n.id} n={shown as EndNode} graph={docView} />)
  })

  return (
    <>
      <svg
        ref={svgRef}
        className={panning ? `${styles.canvas} ${styles.panning}` : styles.canvas}
        role="application"
        aria-label={t('playbooks.canvasLabel')}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            removeSelected()
          } else if (event.key === 'Escape') select(null)
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          const element = event.target as Element
          const portEl = element.closest('[data-port]')
          const point = toWorld(event.clientX, event.clientY)
          if (portEl && point) {
            const from = portEl.getAttribute('data-from') as string
            const port = portEl.getAttribute('data-port') as DocPort
            drag.current = { kind: 'link', from, port, x: point[0], y: point[1] }
            setLink({ from, port, x: point[0], y: point[1] })
            return
          }
          const edgeEl = element.closest('[data-edge]')
          if (edgeEl) {
            select(edgeEl.getAttribute('data-edge'))
            drag.current = null
            return
          }
          const id = element.closest('[data-node]')?.getAttribute('data-node')
          const node = id ? byDoc.get(id) : undefined
          if (node && point) {
            drag.current = {
              kind: 'node',
              id: node.id,
              ox: point[0] - node.x,
              oy: point[1] - node.y,
              sx: event.clientX,
              sy: event.clientY,
              moved: false,
            }
          } else if (view) {
            drag.current = {
              kind: 'pan',
              sx: event.clientX,
              sy: event.clientY,
              vx: view.x,
              vy: view.y,
              moved: false,
            }
            setPanning(true)
          }
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (!current) return
          if (current.kind === 'link') {
            const point = toWorld(event.clientX, event.clientY)
            if (point) setLink({ from: current.from, port: current.port, x: point[0], y: point[1] })
            return
          }
          if (Math.hypot(event.clientX - current.sx, event.clientY - current.sy) > 3)
            current.moved = true
          if (!current.moved) return
          if (current.kind === 'pan') {
            const { vx, vy, sx, sy } = current
            setView((previous) =>
              previous
                ? { ...previous, x: vx + event.clientX - sx, y: vy + event.clientY - sy }
                : previous,
            )
          } else {
            const point = toWorld(event.clientX, event.clientY)
            const node = byDoc.get(current.id)
            if (!point || !node) return
            node.x = Math.round((point[0] - current.ox) / 10) * 10
            node.y = Math.round((point[1] - current.oy) / 10) * 10
            redraw()
          }
        }}
        onPointerUp={(event) => {
          const current = drag.current
          drag.current = null
          setPanning(false)
          if (!current) return
          if (current.kind === 'link') {
            setLink(null)
            const point = toWorld(event.clientX, event.clientY)
            const target = point ? nodeAt(doc, point[0], point[1], current.from) : null
            if (target && connect(doc, current.from, current.port, target.id)) onStructure()
            return
          }
          if (!current.moved) select(current.kind === 'node' ? current.id : null)
          else if (current.kind === 'node') saveLayout(wf)
        }}
      >
        <defs>
          <pattern
            id={gridId}
            width={20}
            height={20}
            patternUnits="userSpaceOnUse"
            patternTransform={view ? `translate(${view.x} ${view.y}) scale(${view.k})` : undefined}
          >
            <circle className={styles.gridDot} cx={1} cy={1} r={1} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${gridId})`} />
        {view ? (
          <g key={pulse} transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <g>
              {doc.edges.map((edge, i) => {
                const from = byDoc.get(edge.from)
                const to = byDoc.get(edge.to)
                if (!from || !to) return null
                const points = edgePoints(from, edge.port, to, () => right + 40 + lanes++ * 14)
                const last = points[points.length - 1]
                const prev = points[points.length - 2]
                const len = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1
                points[points.length - 1] = [
                  last[0] - ((last[0] - prev[0]) / len) * 2,
                  last[1] - ((last[1] - prev[1]) / len) * 2,
                ]
                const key = edgeKey(edge)
                const on = docView.edgeOn(i)
                const fail =
                  edge.port === 'fail' ||
                  (from.kind === 'phase' && to.kind === 'gate' && to.y < from.y)
                const tone =
                  selectedId === key
                    ? 'selected'
                    : docView.sim.neutral
                      ? 'neutral'
                      : !on
                        ? 'idle'
                        : docView.sim.blocked
                          ? 'danger'
                          : fail
                            ? 'warn'
                            : 'on'
                const d = rounded(points)
                return (
                  <g key={key} className={styles.edge} data-tone={tone}>
                    <path
                      d={d}
                      fill="none"
                      strokeWidth={on || selectedId === key ? 1.8 : 1.2}
                      strokeDasharray={
                        on || docView.sim.neutral || selectedId === key ? undefined : '5 5'
                      }
                      strokeLinejoin="round"
                    />
                    <path className={styles.arrow} d={arrowHead(points)} />
                    <path className={styles.edgeHit} data-edge={key} d={d} fill="none" />
                  </g>
                )
              })}
              {link
                ? (() => {
                    const from = byDoc.get(link.from)
                    if (!from) return null
                    const [x, y] = portPoint(from, link.port)
                    return (
                      <path className={styles.linkDraft} d={`M${x} ${y} L${link.x} ${link.y}`} />
                    )
                  })()
                : null}
            </g>
            <g>{links}</g>
            <g className={styles.nodes}>{shapes}</g>
            <g>
              {doc.nodes.map((n) => {
                const { w, h } = nodeSize(n)
                return (
                  <g key={n.id}>
                    {problemNodes.has(n.id) ? (
                      <rect
                        className={styles.problem}
                        x={n.x - 6}
                        y={n.y - 6}
                        width={w + 12}
                        height={h + 12}
                        rx={12}
                      />
                    ) : null}
                    {n.kind !== 'start' ? (
                      <circle className={styles.portIn} cx={n.x + w / 2} cy={n.y} r={4} />
                    ) : null}
                    {OUT_PORTS[n.kind].map((port) => {
                      const [cx, cy] = portPoint(n, port)
                      return (
                        <circle
                          key={port}
                          className={styles.port}
                          data-port={port}
                          data-from={n.id}
                          cx={cx}
                          cy={cy}
                          r={6}
                        >
                          <title>{t(`playbooks.port.${port}` as MessageKey)}</title>
                        </circle>
                      )
                    })}
                  </g>
                )
              })}
            </g>
          </g>
        ) : null}
      </svg>
      <Palette open={paletteOpen} onToggle={() => setPaletteOpen(!paletteOpen)} onDrop={drop} />
      <div className={styles.zoom}>
        <button
          type="button"
          aria-label={t('playbooks.zoomIn')}
          title={t('playbooks.zoomIn')}
          onClick={() => zoomBy(1.2)}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          aria-label={t('playbooks.zoomOut')}
          title={t('playbooks.zoomOut')}
          onClick={() => zoomBy(1 / 1.2)}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          aria-label={t('playbooks.fit')}
          title={t('playbooks.fit')}
          onClick={fit}
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          aria-label={t('playbooks.tidy')}
          title={wf.problems?.length ? t('playbooks.tidyBlocked') : t('playbooks.tidy')}
          disabled={Boolean(wf.problems?.length)}
          onClick={() => {
            tidyDoc(s, wf)
            redraw()
            fit()
          }}
        >
          <LayoutGrid size={12} />
        </button>
      </div>
    </>
  )
}

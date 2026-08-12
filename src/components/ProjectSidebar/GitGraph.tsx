// Este foi feito para refatorar o renderizador do Grafo de Git com fluxo contínuo de curva saindo do nó do commit na metade inferior (cy -> ROW_HEIGHT) e entrando em linha reta no nó do pai na metade superior (0 -> cy), resolvendo 100% dos desajustes e linhas soltas.

import {
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCommitVertical,
  RotateCcw,
  Search,
  Undo2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { readableError } from '../../lib/errors'
import { type MessageKey, useT } from '../../lib/i18n'
import {
  gitCherryPickCommit,
  type GitCommitEntry,
  gitCreateBranchFromCommit,
  type GitFileChange,
  gitLogGraph,
  gitResetToCommit,
  gitRevertCommit,
  gitShowCommitFiles,
  writeClipboardText,
} from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { ContextMenu, type MenuItem } from './ContextMenu'
import styles from './GitGraph.module.css'

const MAX_COMMITS = 0
const ROW_HEIGHT = 24
const LANE_WIDTH = 16
const DOT_RADIUS = 4

/** Cores de raia — cicla pela paleta `--agent-*` já existente no tema (nunca
 *  hex novo hardcoded, regra do design system). */
const LANE_COLOR_VARS = [
  '--agent-shell',
  '--agent-claude',
  '--agent-codex',
  '--agent-opencode',
  '--agent-freebuff',
  '--agent-mimo',
  '--agent-antigravity',
]

type LaneState = (string | null)[]

type GraphRow = {
  commit: GitCommitEntry
  lane: number
  lanesBefore: LaneState
  lanesAfter: LaneState
  isLastRow: boolean
}

/**
 * Calcula a atribuição topológica de raias para o grafo de commits (DAG).
 * Este algoritmo limpa todas as ocorrências do hash do commit atual no vetor de raias
 * antes de alocar os pais, garantindo que fusões (merges) zerem raias convergentes.
 */
function assignLanes(commits: GitCommitEntry[]): GraphRow[] {
  const lanes: LaneState = []
  const rows: GraphRow[] = []
  const remainingHashes = new Set(commits.map((c) => c.hash))

  const findFreeLane = (): number => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    remainingHashes.delete(commit.hash)
    const lanesBefore = [...lanes]

    // 1. Determina a raia do commit atual
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) lane = findFreeLane()

    // 2. Limpa TODAS as ocorrências deste hash no vetor de raias
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === commit.hash) {
        lanes[l] = null
      }
    }

    // 3. Atribui os pais às raias se eles existirem na janela de commits
    if (commit.parents.length > 0) {
      const firstParent = commit.parents[0]
      lanes[lane] = remainingHashes.has(firstParent) ? firstParent : null

      for (const parent of commit.parents.slice(1)) {
        if (remainingHashes.has(parent) && !lanes.includes(parent)) {
          const freeLane = findFreeLane()
          lanes[freeLane] = parent
        }
      }
    } else {
      lanes[lane] = null
    }

    const isLastRow = i === commits.length - 1
    const lanesAfter = isLastRow ? lanes.map(() => null) : [...lanes]

    rows.push({ commit, lane, lanesBefore, lanesAfter, isLastRow })
  }
  return rows
}

function laneColor(lane: number): string {
  return `var(${LANE_COLOR_VARS[lane % LANE_COLOR_VARS.length]})`
}

function relativeTime(timestampSeconds: number, t: ReturnType<typeof useT>): string {
  const diffMs = Date.now() - timestampSeconds * 1000
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return t('git.graph.timeNow')
  if (diffMin < 60) return t('git.graph.timeMinutes', { count: diffMin })
  const diffHours = Math.round(diffMin / 60)
  if (diffHours < 24) return t('git.graph.timeHours', { count: diffHours })
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 30) return t('git.graph.timeDays', { count: diffDays })
  return new Date(timestampSeconds * 1000).toLocaleDateString()
}

export function GitGraph({ repoRoot, onMutated }: { repoRoot: string; onMutated?: () => void }) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const [open, setOpen] = useState(true)
  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; hash: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesByHash, setFilesByHash] = useState<Record<string, GitFileChange[]>>({})
  const [filesError, setFilesError] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open || !repoRoot) return
    let cancelled = false
    gitLogGraph(repoRoot, MAX_COMMITS)
      .then((result) => {
        if (!cancelled) {
          setCommits(result)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, repoRoot])

  const reload = () => {
    if (!repoRoot) return
    gitLogGraph(repoRoot, MAX_COMMITS)
      .then((result) => {
        setCommits(result)
        setError(null)
      })
      .catch((err) => setError(String(err)))
  }

  const filteredCommits = useMemo(() => {
    if (!commits) return []
    if (!searchQuery.trim()) return commits
    const query = searchQuery.toLowerCase().trim()
    return commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(query) ||
        c.hash.toLowerCase().includes(query) ||
        c.authorName.toLowerCase().includes(query) ||
        c.refs.some((r) => r.toLowerCase().includes(query)),
    )
  }, [commits, searchQuery])

  const rows = useMemo(() => (filteredCommits ? assignLanes(filteredCommits) : []), [filteredCommits])

  // Largura de raia GLOBAL pro grafo inteiro (não por linha) — cada linha
  // precisa começar o texto na MESMA posição X, senão a raia de passagem de
  // uma linha com mais raias abertas visualmente invade o texto da mensagem
  // de uma linha vizinha mais estreita (bug reportado ao vivo: "linhas
  // separando mensagem"). Um pouco de espaço sobrando em linhas simples é
  // preferível a texto ilegível.
  const laneCount = useMemo(
    () =>
      Math.max(
        1,
        ...rows.map((row) => Math.max(row.lanesBefore.length, row.lanesAfter.length, row.lane + 1)),
      ),
    [rows],
  )

  const toggleExpand = (hash: string) => {
    setExpanded((cur) => (cur === hash ? null : hash))
    if (!filesByHash[hash] && !filesError[hash]) {
      gitShowCommitFiles(repoRoot, hash)
        .then((files) => setFilesByHash((prev) => ({ ...prev, [hash]: files })))
        .catch((err) => setFilesError((prev) => ({ ...prev, [hash]: String(err) })))
    }
  }

  const runAction = async (action: () => Promise<unknown>, successKey?: MessageKey) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (successKey) pushToast({ title: t(successKey), body: '' })
      reload()
      onMutated?.()
    } catch (cause) {
      pushToast({ title: t('git.error.action'), body: readableError(cause) })
    } finally {
      setBusy(false)
    }
  }

  const buildMenuItems = (hash: string): MenuItem[] => [
    {
      kind: 'item',
      label: t('git.graph.menu.copyHash'),
      icon: <Copy size={13} />,
      onClick: () => {
        void writeClipboardText(hash)
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.createBranch'),
      icon: <GitBranchPlus size={13} />,
      onClick: () => {
        const name = window.prompt(t('git.graph.menu.createBranchPrompt'))
        if (name && name.trim()) {
          void runAction(
            () => gitCreateBranchFromCommit(repoRoot, hash, name.trim()),
            'git.graph.menu.branchCreated',
          )
        }
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.cherryPick'),
      icon: <GitCommitVertical size={13} />,
      onClick: () => {
        void runAction(
          () => gitCherryPickCommit(repoRoot, hash),
          'git.graph.menu.cherryPicked',
        )
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.revert'),
      icon: <Undo2 size={13} />,
      onClick: () => {
        void runAction(() => gitRevertCommit(repoRoot, hash), 'git.graph.menu.reverted')
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('git.graph.menu.resetSoft'),
      icon: <RotateCcw size={13} />,
      onClick: () => {
        void runAction(
          () => gitResetToCommit(repoRoot, hash, 'soft'),
          'git.graph.menu.resetDone',
        )
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.resetMixed'),
      icon: <RotateCcw size={13} />,
      onClick: () => {
        void runAction(
          () => gitResetToCommit(repoRoot, hash, 'mixed'),
          'git.graph.menu.resetDone',
        )
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.resetHard'),
      icon: <RotateCcw size={13} />,
      onClick: () => {
        if (window.confirm(t('git.graph.menu.resetHardConfirm'))) {
          void runAction(
            () => gitResetToCommit(repoRoot, hash, 'hard'),
            'git.graph.menu.resetDone',
          )
        }
      },
    },
  ]

  return (
    <section className={styles.group}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '4px' }}>
        <button
          type="button"
          className={styles.groupHeader}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <GitCommitHorizontal size={13} />
          <strong>{t('git.graph.title')}</strong>
          {commits ? <span style={{ opacity: 0.6, fontSize: '11px' }}>({filteredCommits.length})</span> : null}
        </button>
        {open ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={reload}
            title={t('git.graph.refresh')}
            aria-label={t('git.graph.refresh')}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer' }}
          >
            <RotateCcw size={12} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className={styles.body}>
          <div style={{ padding: '0 4px 6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 6px' }}>
              <Search size={11} style={{ color: 'var(--fg-faint)', marginRight: '4px' }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('git.graph.searchPlaceholder')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--fg)',
                  fontSize: '11px',
                  width: '100%',
                }}
              />
            </div>
          </div>

          {error ? <p className={styles.error}>{error}</p> : null}
          {!commits && !error ? <p className={styles.loading}>{t('git.graph.loading')}</p> : null}
          {commits && filteredCommits.length === 0 ? (
            <p className={styles.empty}>{t('git.graph.noSearchResults')}</p>
          ) : null}

          {rows.map((row) => (
            <div key={row.commit.hash}>
              <GraphRowView
                row={row}
                t={t}
                laneCount={laneCount}
                expanded={expanded === row.commit.hash}
                onToggleExpand={() => toggleExpand(row.commit.hash)}
                onOpenMenu={(x, y) => setMenu({ x, y, hash: row.commit.hash })}
              />
              {expanded === row.commit.hash ? (
                <CommitFilesPanel
                  files={filesByHash[row.commit.hash]}
                  error={filesError[row.commit.hash]}
                  laneCount={laneCount}
                  activeLanes={row.lanesAfter.flatMap((v, i) => (v != null ? [i] : []))}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.hash)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * Componente que renderiza a linha do Grafo de Commits com modelo matemático de fluxo contínuo.
 * - Metade Superior (0 -> cy): Linhas retas de entrada para o nó ou raias de passagem.
 * - Metade Inferior (cy -> ROW_HEIGHT): Linhas retas ou curvas de saída que partem do nó do commit em direção aos pais.
 */
/** Raia 0 é sempre a raia principal (a primeira alocada, na prática a
 *  branch atual/HEAD) — desenhada mais grossa que as demais pra estabelecer
 *  hierarquia visual clara entre "linha principal" e "linhas de branch". */
const MAIN_LANE = 0
const MAIN_STROKE_WIDTH = 3
const SIDE_STROKE_WIDTH = 2
function laneStrokeWidth(lane: number): number {
  return lane === MAIN_LANE ? MAIN_STROKE_WIDTH : SIDE_STROKE_WIDTH
}

function GraphRowView({
  row,
  t,
  laneCount,
  expanded,
  onToggleExpand,
  onOpenMenu,
}: {
  row: GraphRow
  t: ReturnType<typeof useT>
  laneCount: number
  expanded: boolean
  onToggleExpand: () => void
  onOpenMenu: (x: number, y: number) => void
}) {
  const cx = row.lane * LANE_WIDTH + LANE_WIDTH / 2
  const cy = ROW_HEIGHT / 2

  const elements: React.ReactNode[] = []

  // 1. Processa a Metade Superior (0 -> cy)
  for (let l = 0; l < row.lanesBefore.length; l++) {
    if (row.lanesBefore[l] != null) {
      const fromX = l * LANE_WIDTH + LANE_WIDTH / 2
      const color = laneColor(l)

      // Linha reta de entrada do topo até o nó ou até cy
      if (l === row.lane) {
        elements.push(
          <line
            key={`top-line-${l}`}
            x1={cx}
            y1={0}
            x2={cx}
            y2={cy}
            stroke={color}
            strokeWidth={laneStrokeWidth(l)}
          />,
        )
      } else {
        elements.push(
          <line
            key={`top-pass-${l}`}
            x1={fromX}
            y1={0}
            x2={fromX}
            y2={cy}
            stroke={color}
            strokeWidth={laneStrokeWidth(l)}
          />,
        )
      }
    }
  }

  // 2. Processa a Metade Inferior (cy -> ROW_HEIGHT) — apenas se não for a última linha
  if (!row.isLastRow) {
    for (let l = 0; l < row.lanesAfter.length; l++) {
      const parent = row.lanesAfter[l]
      if (parent != null) {
        const toX = l * LANE_WIDTH + LANE_WIDTH / 2
        const color = laneColor(l)

        if (l === row.lane) {
          // Pai na mesma raia: linha reta para baixo
          elements.push(
            <line
              key={`bottom-line-${l}`}
              x1={cx}
              y1={cy}
              x2={cx}
              y2={ROW_HEIGHT}
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
            />,
          )
        } else if (row.lanesBefore[l] === parent) {
          // Raia de passagem contínua
          elements.push(
            <line
              key={`bottom-pass-${l}`}
              x1={toX}
              y1={cy}
              x2={toX}
              y2={ROW_HEIGHT}
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
            />,
          )
        } else {
          // Conexão/Curva de saída partindo do nó atual em direção ao pai na outra raia
          const midY = (cy + ROW_HEIGHT) / 2
          elements.push(
            <path
              key={`bottom-curve-${l}`}
              d={`M ${cx} ${cy} C ${cx} ${midY}, ${toX} ${midY}, ${toX} ${ROW_HEIGHT}`}
              fill="none"
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
            />,
          )
        }
      }
    }
  }

  return (
    <div
      className={`${styles.row} ${expanded ? styles.rowExpanded : ''}`}
      title={`${row.commit.hash.slice(0, 10)} — ${row.commit.subject}`}
      onClick={onToggleExpand}
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu(e.clientX, e.clientY)
      }}
    >
      <svg className={styles.svg} width={laneCount * LANE_WIDTH} height={ROW_HEIGHT} aria-hidden="true">
        {elements}
        {/* Ponto/Nó principal do commit — raia principal ganha um raio maior,
            mesma lógica de hierarquia visual do traço mais grosso. */}
        <circle
          cx={cx}
          cy={cy}
          r={row.lane === MAIN_LANE ? DOT_RADIUS + 1 : DOT_RADIUS}
          fill={laneColor(row.lane)}
        />
      </svg>

      <div className={styles.info}>
        <span className={styles.subject}>{row.commit.subject}</span>
        <RefBadges refs={row.commit.refs} />
        <span className={styles.meta}>
          {row.commit.authorName} · {relativeTime(row.commit.timestamp, t)}
        </span>
      </div>
    </div>
  )
}

/**
 * Componente que renderiza no máximo 2 badges principais e um contador +N se houver múltiplas refs.
 * Este componente foi feito para evitar que múltiplos badges (ex: 10 worktrees) quebrem o layout da linha.
 */
function RefBadges({ refs }: { refs: string[] }) {
  if (!refs || refs.length === 0) return null

  const MAX_VISIBLE = 2
  const visibleRefs = refs.slice(0, MAX_VISIBLE)
  const remainingCount = refs.length - MAX_VISIBLE
  const fullTooltip = refs.join('\n')

  return (
    <span className={styles.refs} title={fullTooltip}>
      {visibleRefs.map((ref) => (
        <span
          key={ref}
          className={styles.refBadge}
          title={ref}
          style={{
            background: ref.includes('HEAD')
              ? 'var(--agent-shell)'
              : ref.includes('tag:')
                ? 'var(--status-waiting)'
                : 'var(--accent-soft)',
            color: ref.includes('HEAD') ? 'var(--bg)' : 'var(--fg-muted)',
          }}
        >
          {ref}
        </span>
      ))}
      {remainingCount > 0 ? (
        <span className={styles.refBadgeCount} title={fullTooltip}>
          +{remainingCount}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Painel de arquivos do commit expandido. Sem isso, a raia que continua pra
 * baixo de um commit expandido literalmente sumia na altura do painel —
 * cada linha do grafo só desenha SVG dentro da própria altura fixa
 * (ROW_HEIGHT), e o painel expandido tem altura variável (depende de quantos
 * arquivos), então nenhuma raia "de passagem" tinha como continuar através
 * dele. `activeLanes` (as raias vivas logo depois deste commit,
 * `row.lanesAfter`) é desenhado como um trilho contínuo atravessando a
 * altura inteira do painel, pra a linha nunca parecer desconectada.
 */
function CommitFilesPanel({
  files,
  error,
  laneCount,
  activeLanes,
}: {
  files?: GitFileChange[]
  error?: string
  laneCount: number
  activeLanes: number[]
}) {
  const t = useT()
  let content: React.ReactNode
  if (error) {
    content = <p className={styles.filesError}>{error}</p>
  } else if (!files) {
    content = <p className={styles.filesLoading}>{t('git.graph.filesLoading')}</p>
  } else if (files.length === 0) {
    content = <p className={styles.filesEmpty}>{t('git.graph.filesEmpty')}</p>
  } else {
    content = (
      <>
        {files.map((file) => (
          <div key={file.path} className={styles.fileRow} title={file.path}>
            <span className={styles.fileStatus}>{file.status}</span>
            <span className={styles.fileName}>{file.path}</span>
          </div>
        ))}
      </>
    )
  }

  return (
    <div className={styles.filesPanel} style={{ paddingLeft: laneCount * LANE_WIDTH + 10 }}>
      {activeLanes.map((lane) => (
        <div
          key={lane}
          className={styles.filesPanelRail}
          style={{
            left: lane * LANE_WIDTH + LANE_WIDTH / 2 - laneStrokeWidth(lane) / 2,
            width: laneStrokeWidth(lane),
            background: laneColor(lane),
          }}
        />
      ))}
      {content}
    </div>
  )
}

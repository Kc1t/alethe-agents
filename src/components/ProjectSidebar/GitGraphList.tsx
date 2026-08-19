import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import type { GitCommitEntry } from '../../lib/tauri'
import styles from './GitGraph.module.css'

// Mais espaçado (estilo GitLens/GitKraken) do que o valor original — mais
// respiro entre raias e entre linhas de commit. `ROW_HEIGHT` tem que bater
// com `.row { height: ... }` em GitGraph.module.css (CSS não importa
// constante de TS, então os dois precisam ser trocados juntos).
// Proporção ROW_HEIGHT×LANE_WIDTH controla o quão "suave" cada curva de
// divergência/convergência parece: a curva cobre LANE_WIDTH na horizontal
// em só METADE de ROW_HEIGHT na vertical (ver `GraphRowView`) — com a
// proporção antiga (20×28, curva usando só 14px verticais) a diagonal ficava
// íngreme e parecia um "cotovelo" em vez de curva, principalmente em
// históricos com várias branches curtas empilhadas em sequência. Subir
// ROW_HEIGHT e descer um pouco LANE_WIDTH deixa a curva bem mais suave sem
// mudar a lógica de desenho.
export const ROW_HEIGHT = 34
const LANE_WIDTH = 18
const DOT_RADIUS = 5
const OVERSCAN = 8

/** Cores de raia — cicla pela paleta `--agent-*` já existente no tema (nunca
 *  hex novo hardcoded, regra do design system). SEM `--agent-shell`: em
 *  TODOS os temas ele tem o mesmíssimo valor hex de `--status-working` (a
 *  cor fixa forçada na raia principal, ver `laneColorForId`) — uma raia
 *  secundária que caísse nesse índice de cor por hash ficava indistinguível
 *  da raia principal, criando um "ziguezague" de uma única cor que parecia
 *  uma linha só se contorcendo em vez de raias distintas convergindo. */
const LANE_COLOR_VARS = [
  '--agent-claude',
  '--agent-codex',
  '--agent-opencode',
  '--agent-freebuff',
  '--agent-mimo',
  '--agent-antigravity',
]

/** Raia 0 é sempre a raia principal (a primeira alocada, na prática a
 *  branch atual/HEAD) — desenhada mais grossa e SEMPRE com a mesma cor fixa
 *  (`--status-working`), independente de qual identidade passa por ela ao
 *  longo do histórico. */
const MAIN_LANE = 0
const MAIN_STROKE_WIDTH = 3
const SIDE_STROKE_WIDTH = 2
function laneStrokeWidth(lane: number): number {
  return lane === MAIN_LANE ? MAIN_STROKE_WIDTH : SIDE_STROKE_WIDTH
}

type LaneState = (string | null)[]
type LaneIdState = (string | null)[]

type GraphRow = {
  commit: GitCommitEntry
  lane: number
  /** Var de cor (ex. `--agent-claude`) já resolvida pro rodízio de cor da
   *  PRÓPRIA raia deste commit — ver `createColorAssigner`. */
  laneId: string | null
  lanesBefore: LaneState
  lanesAfter: LaneState
  laneIdsBefore: LaneIdState
  laneIdsAfter: LaneIdState
  isLastRow: boolean
}

/** Extrai um nome de ref limpo de uma entrada de decoração (`%D`) — ignora
 *  tags (`tag: ...`) e resolve `HEAD -> nome` pro `nome` em si. */
function normalizeRefName(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('tag: ')) return null
  const arrow = trimmed.indexOf(' -> ')
  const name = arrow !== -1 ? trimmed.slice(arrow + 4).trim() : trimmed
  return name || null
}

/** Melhor nome de branch pra decorar cada commit de ponta — prioriza branch
 *  LOCAL sobre `origin/*`, e colapsa `origin/main`/`main` na mesma
 *  identidade (local e remota da mesma branch nunca divergem de cor). Nomes
 *  de branch só existem na decoração do commit de ponta; commits no meio da
 *  história não têm ref nenhuma — por isso o fallback em `identityFor`. */
function buildBranchByHash(commits: GitCommitEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of commits) {
    let best: string | null = null
    let bestIsLocal = false
    for (const raw of c.refs) {
      const parsed = normalizeRefName(raw)
      if (!parsed) continue
      const isLocal = !parsed.startsWith('origin/')
      const name = isLocal ? parsed : parsed.slice('origin/'.length)
      if (best === null || (isLocal && !bestIsLocal)) {
        best = name
        bestIsLocal = isLocal
      }
    }
    if (best) map.set(c.hash, best)
  }
  return map
}

/** Identidade estável pra colorir uma raia: nome da branch quando disponível,
 *  senão o próprio hash do commit que originou a raia — o hash nunca muda,
 *  então a cor nunca muda mesmo sem nome de branch pra usar. */
function identityFor(hash: string, branchByHash: Map<string, string>): string {
  return branchByHash.get(hash) ?? hash
}

/** Atribui a cor de cada identidade por RODÍZIO (não por hash) — cada
 *  identidade nova encontrada ganha a PRÓXIMA cor não usada da paleta, na
 *  ordem em que as raias vão nascendo de cima pra baixo no histórico. Um
 *  hash puro (`id → índice`) não garante nada sobre raias VIZINHAS — duas
 *  branches diferentes podem cair no mesmo índice por coincidência, o que
 *  fica bem visível num histórico com várias branches curtas em sequência
 *  (parecia repetição/ziguezague de uma cor só). Rodízio garante que raias
 *  vizinhas nunca repetem cor (só depois de esgotar a paleta inteira), e a
 *  identidade mantém a MESMA cor se reaparecer mais adiante no histórico
 *  (cache no Map, não reatribui).
 */
function createColorAssigner(): (identity: string) => string {
  const assigned = new Map<string, string>()
  let next = 0
  return (identity: string) => {
    const cached = assigned.get(identity)
    if (cached) return cached
    const color = LANE_COLOR_VARS[next % LANE_COLOR_VARS.length]
    next += 1
    assigned.set(identity, color)
    return color
  }
}

function laneColorForId(lane: number, colorVar: string | null): string {
  if (lane === MAIN_LANE) return 'var(--status-working)'
  if (!colorVar) return 'var(--fg-faint)'
  return `var(${colorVar})`
}

/**
 * Calcula a atribuição topológica de raias do grafo de commits (DAG), com
 * identidade estável por raia (`laneId`) pra colorir sempre a mesma branch
 * com a mesma cor, mesmo quando a coluna numérica é reciclada. SEMPRE roda
 * sobre a lista COMPLETA de commits — nunca sobre uma lista já filtrada por
 * busca, senão o algoritmo perde a topologia real (um pai fora do filtro
 * simplesmente deixa de existir pro cálculo) e as linhas "param no nada".
 * A busca (ver `GitGraphList`) só decide quais linhas ficam em destaque,
 * nunca realimenta este cálculo.
 */
function buildGraphRows(commits: GitCommitEntry[]): GraphRow[] {
  const branchByHash = buildBranchByHash(commits)
  const colorFor = createColorAssigner()
  const lanes: LaneState = []
  const laneIds: LaneIdState = []
  const rows: GraphRow[] = []
  const remainingHashes = new Set(commits.map((c) => c.hash))

  const findFreeLane = (): number => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    laneIds.push(null)
    return lanes.length - 1
  }

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    remainingHashes.delete(commit.hash)
    const lanesBefore = [...lanes]
    const laneIdsBefore = [...laneIds]

    // 1. Determina a raia do commit atual — se é uma raia nova, registra a
    //    cor de origem dela agora (rodízio, não hash — ver createColorAssigner).
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) {
      lane = findFreeLane()
      laneIds[lane] = colorFor(identityFor(commit.hash, branchByHash))
    }
    const laneId = laneIds[lane] ?? colorFor(identityFor(commit.hash, branchByHash))

    // 2. Limpa TODAS as ocorrências deste hash no vetor de raias
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === commit.hash) lanes[l] = null
    }

    // 3. Atribui os pais às raias se eles existirem na janela de commits
    if (commit.parents.length > 0) {
      const firstParent = commit.parents[0]
      // Primeiro pai CONTINUA na mesma raia — não mexe em laneIds[lane], é
      // isso que preserva a cor ao longo de toda a branch.
      lanes[lane] = remainingHashes.has(firstParent) ? firstParent : null

      for (const parent of commit.parents.slice(1)) {
        if (remainingHashes.has(parent) && !lanes.includes(parent)) {
          const freeLane = findFreeLane()
          lanes[freeLane] = parent
          laneIds[freeLane] = colorFor(identityFor(parent, branchByHash))
        }
      }
    } else {
      lanes[lane] = null
    }

    const isLastRow = i === commits.length - 1
    const lanesAfter = isLastRow ? lanes.map(() => null) : [...lanes]
    const laneIdsAfter = isLastRow ? laneIds.map(() => null) : [...laneIds]

    rows.push({
      commit,
      lane,
      laneId,
      lanesBefore,
      lanesAfter,
      laneIdsBefore,
      laneIdsAfter,
      isLastRow,
    })
  }
  return rows
}

export function relativeTime(timestampSeconds: number, t: ReturnType<typeof useT>): string {
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

/**
 * Componente que renderiza no máximo 2 badges principais e um contador +N se houver múltiplas refs.
 * Este componente foi feito para evitar que múltiplos badges (ex: 10 worktrees) quebrem o layout da linha.
 */
export function RefBadges({ refs }: { refs: string[] }) {
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
 * Componente que renderiza a linha do Grafo de Commits com modelo matemático de fluxo contínuo.
 * - Metade Superior (0 -> cy): Linhas retas de entrada para o nó ou raias de passagem.
 * - Metade Inferior (cy -> ROW_HEIGHT): Linhas retas ou curvas de saída que partem do nó do commit em direção aos pais.
 */
function GraphRowView({
  row,
  t,
  laneCount,
  dimmed,
  onSelect,
  onOpenMenu,
}: {
  row: GraphRow
  t: ReturnType<typeof useT>
  laneCount: number
  dimmed: boolean
  onSelect: () => void
  onOpenMenu: (x: number, y: number) => void
}) {
  const cx = row.lane * LANE_WIDTH + LANE_WIDTH / 2
  const cy = ROW_HEIGHT / 2

  const elements: React.ReactNode[] = []

  // 1. Processa a Metade Superior (0 -> cy)
  for (let l = 0; l < row.lanesBefore.length; l++) {
    if (row.lanesBefore[l] != null) {
      const fromX = l * LANE_WIDTH + LANE_WIDTH / 2
      const color = laneColorForId(l, row.laneIdsBefore[l] ?? null)

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
            strokeLinecap="round"
          />,
        )
      } else if (row.lanesBefore[l] === row.commit.hash) {
        // Ponto de convergência: outra raia também apontava pra este commit
        // (ex.: uma branch que se originou dele) — em vez de continuar reta
        // e sumir no vazio, curva pra dentro do ponto do commit e se funde
        // ali, igual à curva de divergência que já existe na metade inferior.
        const midY = cy / 2
        elements.push(
          <path
            key={`top-merge-${l}`}
            d={`M ${fromX} 0 C ${fromX} ${midY}, ${cx} ${midY}, ${cx} ${cy}`}
            fill="none"
            stroke={color}
            strokeWidth={laneStrokeWidth(l)}
            strokeLinecap="round"
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
            strokeLinecap="round"
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
        const color = laneColorForId(l, row.laneIdsAfter[l] ?? null)

        if (l === row.lane) {
          elements.push(
            <line
              key={`bottom-line-${l}`}
              x1={cx}
              y1={cy}
              x2={cx}
              y2={ROW_HEIGHT}
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
              strokeLinecap="round"
            />,
          )
        } else if (row.lanesBefore[l] === parent) {
          elements.push(
            <line
              key={`bottom-pass-${l}`}
              x1={toX}
              y1={cy}
              x2={toX}
              y2={ROW_HEIGHT}
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
              strokeLinecap="round"
            />,
          )
        } else {
          const midY = (cy + ROW_HEIGHT) / 2
          elements.push(
            <path
              key={`bottom-curve-${l}`}
              d={`M ${cx} ${cy} C ${cx} ${midY}, ${toX} ${midY}, ${toX} ${ROW_HEIGHT}`}
              fill="none"
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
              strokeLinecap="round"
            />,
          )
        }
      }
    }
  }

  return (
    <div
      className={`${styles.row} ${dimmed ? styles.rowDimmed : ''}`}
      title={`${row.commit.hash.slice(0, 10)} — ${row.commit.subject}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu(e.clientX, e.clientY)
      }}
    >
      <svg
        className={styles.svg}
        width={laneCount * LANE_WIDTH}
        height={ROW_HEIGHT}
        aria-hidden="true"
      >
        {elements}
        {/* Ponto/Nó principal do commit — raia principal ganha um raio maior,
            mesma lógica de hierarquia visual do traço mais grosso. O
            contorno na cor do fundo "corta" visualmente as linhas que
            passam atrás do ponto, estilo GitLens/GitKraken. */}
        <circle
          cx={cx}
          cy={cy}
          r={row.lane === MAIN_LANE ? DOT_RADIUS + 1.5 : DOT_RADIUS}
          fill={laneColorForId(row.lane, row.laneId)}
          stroke="var(--bg)"
          strokeWidth={2}
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

export type GitGraphListProps = {
  commits: GitCommitEntry[]
  searchQuery: string
  /** Posição de scroll a restaurar ao montar (voltando da tela de detalhe). */
  initialScrollTop: number
  onSelectCommit: (hash: string, scrollTop: number) => void
  onOpenMenu: (x: number, y: number, hash: string) => void
}

/** Lista/grafo de commits propriamente dito — cálculo de raias, cor estável
 *  por identidade, e virtualização (windowing manual, sem dependência nova:
 *  cada linha tem altura fixa de `ROW_HEIGHT`, o caso mais simples possível
 *  pra virtualizar). */
export function GitGraphList({
  commits,
  searchQuery,
  initialScrollTop,
  onSelectCommit,
  onOpenMenu,
}: GitGraphListProps) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const [scrollTop, setScrollTop] = useState(initialScrollTop)
  const [viewportHeight, setViewportHeight] = useState(380)

  const rows = useMemo(() => buildGraphRows(commits), [commits])

  // Largura de raia GLOBAL pro grafo inteiro (não por linha) — cada linha
  // precisa começar o texto na MESMA posição X, senão a raia de passagem de
  // uma linha com mais raias abertas visualmente invade o texto da mensagem
  // de uma linha vizinha mais estreita. Loop manual (não spread+Math.max) —
  // com histórico grande, espalhar milhares de números como argumentos
  // estoura a pilha de chamada.
  const laneCount = useMemo(() => {
    let max = 1
    for (const row of rows) {
      max = Math.max(max, row.lanesBefore.length, row.lanesAfter.length, row.lane + 1)
    }
    return max
  }, [rows])

  // null = sem busca ativa (ninguém fica esmaecido). Nunca reduz `rows` —
  // só marca quais commits batem, pra nunca perder a continuidade visual do
  // grafo (ver comentário de `buildGraphRows`).
  const matchingHashes = useMemo(() => {
    const query = searchQuery.toLowerCase().trim()
    if (!query) return null
    const set = new Set<string>()
    for (const row of rows) {
      const c = row.commit
      if (
        c.subject.toLowerCase().includes(query) ||
        c.hash.toLowerCase().includes(query) ||
        c.authorName.toLowerCase().includes(query) ||
        c.refs.some((r) => r.toLowerCase().includes(query))
      ) {
        set.add(c.hash)
      }
    }
    return set
  }, [rows, searchQuery])

  // Restaura a posição de scroll salva ao voltar da tela de detalhe — só na
  // montagem (o componente inteiro desmonta/remonta ao trocar de view).
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScrollTop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop
    // rAF-throttled — sem isso, `onScroll` dispara a cada pixel rolado e
    // recalcula a janela visível bem mais vezes do que a tela consegue
    // pintar.
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setScrollTop(top)
    })
  }

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  )
  const visibleRows = rows.slice(startIndex, endIndex)
  const noMatches = matchingHashes != null && matchingHashes.size === 0

  return (
    <>
      {noMatches ? <p className={styles.empty}>{t('git.graph.noSearchResults')}</p> : null}
      <div className={styles.body} ref={scrollRef} onScroll={onScroll}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ position: 'absolute', top: startIndex * ROW_HEIGHT, left: 0, right: 0 }}>
            {visibleRows.map((row) => (
              <GraphRowView
                key={row.commit.hash}
                row={row}
                t={t}
                laneCount={laneCount}
                dimmed={matchingHashes != null && !matchingHashes.has(row.commit.hash)}
                onSelect={() =>
                  onSelectCommit(row.commit.hash, scrollRef.current?.scrollTop ?? scrollTop)
                }
                onOpenMenu={(x, y) => onOpenMenu(x, y, row.commit.hash)}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

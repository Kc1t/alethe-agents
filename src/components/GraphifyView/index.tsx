import { useEffect, useMemo, useRef } from 'react'
import cytoscape from 'cytoscape'
import { RefreshCw, Camera, Scissors, RotateCcw, X, Network, Loader2 } from 'lucide-react'
import { useGraphifyStore } from '../../stores/graphifyStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useT } from '../../lib/i18n'
import styles from './GraphifyView.module.css'

/** Quantos snapshots manter ao compactar (memory policy). */
const KEEP_LAST = 10

                                                                            
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

type GraphifyViewProps = {
                                                            
  repo: string
                                                                
  projectId: string
                                                                         
  terminalId: string
}

   
                                                                         
                                                                                
                             
   
export function GraphifyView({ repo, projectId, terminalId }: GraphifyViewProps) {
  const t = useT()
  const {
    graph,
    snapshots,
    error,
    loading,
    load,
    generateGraph,
    refreshGraph,
    snapshot,
    rollback,
    prune,
  } = useGraphifyStore()
  const deleteTerminal = useProjectsStore((state) => state.deleteTerminal)
  const canvasRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<cytoscape.Core | null>(null)

  useEffect(() => {
    void load(repo)
  }, [repo, load])

                                                                           
                                                                        
                                                                            
                                                                      
  const RENDER_NODE_LIMIT = 250
  const { elements, renderTruncated } = useMemo(() => {
    if (!graph) return { elements: [] as cytoscape.ElementDefinition[], renderTruncated: false }
    if (graph.nodes.length <= RENDER_NODE_LIMIT) {
      return {
        elements: [
          ...graph.nodes.map((n) => ({ data: { id: n.id, label: n.label, kind: n.kind ?? '' } })),
          ...graph.edges.map((e) => ({
            data: { id: e.id, source: e.source, target: e.target, label: e.label ?? '' },
          })),
        ],
        renderTruncated: false,
      }
    }
    const degree = new Map<string, number>()
    for (const e of graph.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    const kept = [...graph.nodes]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, RENDER_NODE_LIMIT)
    const keptIds = new Set(kept.map((n) => n.id))
    const keptEdges = graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    return {
      elements: [
        ...kept.map((n) => ({ data: { id: n.id, label: n.label, kind: n.kind ?? '' } })),
        ...keptEdges.map((e) => ({
          data: { id: e.id, source: e.source, target: e.target, label: e.label ?? '' },
        })),
      ],
      renderTruncated: true,
    }
  }, [graph])

  useEffect(() => {
    const container = canvasRef.current
    if (!container || !graph) return

                                                                         
                                                                        
                                                                            
                                                                           
                                                                           
                                                                         
    // clustering visual realmente compensa o custo.
    const COSE_NODE_LIMIT = 300
    const layout: cytoscape.LayoutOptions =
      elements.length > COSE_NODE_LIMIT
        ? { name: 'grid', animate: false, condense: true }
        : { name: 'cose', animate: false, nodeDimensionsIncludeLabels: true }

    const cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': token('--accent', '#6ea8fe'),
            label: 'data(label)',
            color: token('--fg', '#e6e6e6'),
            'font-size': '9px',
            'text-valign': 'bottom',
            'text-halign': 'center',
            width: 14,
            height: 14,
            'text-max-width': '80px',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1,
            'line-color': token('--border', '#3a3a3a'),
            'target-arrow-color': token('--border', '#3a3a3a'),
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.7,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'background-color': token('--accent-strong', token('--accent', '#6ea8fe')),
            'border-width': 2,
            'border-color': token('--accent-ring', token('--accent', '#6ea8fe')),
          },
        },
      ],
      layout,
                                                                          
                                                                            
                                                                 
      wheelSensitivity: 3,
    })
    cyRef.current = cy
    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [elements, graph])

  const hasGraph = !!graph && graph.nodes.length > 0

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.title}>{t('graphify.title')}</span>
        {hasGraph && (
          <span className={styles.stats}>
            {t('graphify.stats', { nodes: graph.nodeCount, edges: graph.edgeCount })}
            {graph.truncated ? ` · ${t('graphify.truncated', { max: graph.nodes.length })}` : ''}
            {renderTruncated
              ? ` · ${t('graphify.renderTruncated', { shown: RENDER_NODE_LIMIT, total: graph.nodes.length })}`
              : ''}
          </span>
        )}
        <span className={styles.spacer} />
        <button className={styles.button} onClick={() => void refreshGraph()} disabled={loading}>
          <RefreshCw size={13} /> {t('graphify.reload')}
        </button>
        <button
          className={styles.button}
          onClick={() => void snapshot(projectId)}
          disabled={!hasGraph}
        >
          <Camera size={13} /> {t('graphify.snapshot')}
        </button>
        <button
          className={styles.button}
          onClick={() => void prune(KEEP_LAST, projectId)}
          disabled={snapshots.length === 0}
          title={t('graphify.pruneHint', { keep: KEEP_LAST })}
        >
          <Scissors size={13} /> {t('graphify.prune')}
        </button>
        <button
          type="button"
          className={styles.closeButton}
          onClick={() => deleteTerminal(projectId, terminalId)}
          title={t('graphify.close')}
          aria-label={t('graphify.close')}
        >
          <X size={15} />
        </button>
      </div>

      <div className={styles.body}>
        {hasGraph ? (
          <div ref={canvasRef} className={styles.canvas} />
        ) : (
          <div className={`${styles.empty} ${error ? styles.error : ''}`}>
            <Network size={30} strokeWidth={1.5} />
            <strong>
              {error === 'graphify_unavailable'
                ? t('graphify.unavailableTitle')
                : t('graphify.emptyTitle')}
            </strong>
            <span>
              {error === 'graphify_unavailable'
                ? t('graphify.unavailable')
                : error === 'graphify_generation_timeout'
                  ? t('graphify.generationTimeout')
                  : error || t('graphify.emptyDescription')}
            </span>
            <button
              className={`${styles.button} ${styles.generateButton}`}
              onClick={() => void generateGraph()}
              disabled={loading}
            >
              {loading ? <Loader2 size={13} className={styles.spin} /> : <Network size={13} />}
              {loading ? t('graphify.generating') : t('graphify.generate')}
            </button>
          </div>
        )}

        <div className={styles.sidebar}>
          <div className={styles.sidebarTitle}>{t('graphify.snapshotsTitle')}</div>
          {snapshots.length === 0 ? (
            <div className={styles.muted}>{t('graphify.noSnapshots')}</div>
          ) : (
            snapshots.map((s) => (
              <div key={s.id} className={styles.snapshot}>
                <div className={styles.snapshotMeta}>
                  <span className={styles.snapshotDate}>
                    {new Date(s.createdMs).toLocaleString()}
                  </span>
                  <span className={styles.snapshotSize}>{Math.round(s.sizeBytes / 1024)} KB</span>
                </div>
                <button
                  className={styles.rollback}
                  onClick={() => void rollback(s.id, projectId)}
                  title={t('graphify.rollback')}
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

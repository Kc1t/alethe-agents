import {
  AlertTriangle,
  Archive,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileText,
  Filter,
  Folder,
  FolderSync,
  HardDrive,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  type BackupArchiveEntry,
  type FolderTreeNode,
  listProjectBackups,
  purgeProjectBackupsSecured,
  scanProjectFolderTree,
  triggerProjectArchiveBackup,
} from '../../lib/tauri'
import { getProjectRepoRoot } from '../../lib/terminalFactory'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './ProjectFolderTreeModal.module.css'

type FilterMode = 'all' | 'essential' | 'heavy' | 'selected'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function getNodeIcon(node: FolderTreeNode) {
  if (node.isDir) {
    return <Folder size={13} className={node.isHeavy ? styles.folderHeavy : styles.folderNormal} />
  }
  if (node.isEssential) {
    return <ShieldCheck size={13} className={styles.fileEssential} />
  }
  const lower = node.name.toLowerCase()
  if (lower.endsWith('.exe') || lower.endsWith('.dll') || lower.endsWith('.bin') || lower.endsWith('.so')) {
    return <FileCode size={13} className={styles.fileBinary} />
  }
  if (lower.endsWith('.zip') || lower.endsWith('.tar') || lower.endsWith('.gz') || lower.endsWith('.7z')) {
    return <Archive size={13} className={styles.fileArchive} />
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.json') || lower.endsWith('.toml')) {
    return <FileText size={13} className={styles.fileNormal} />
  }
  return <File size={13} className={node.isHeavy ? styles.fileHeavy : styles.fileNormal} />
}

export function ProjectFolderTreeModal() {
  const closeModal = useUiStore((s) => s.closeModal)
  const pushToast = useUiStore((s) => s.pushToast)
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]
  // Prefer the terminal-derived root over the raw `defaultCwd` — a merge/conflict-resolution
  // agent's ephemeral folder can leave `defaultCwd` pointing at a dead `.alethe/merge-envs/*`
  // or `.alethe/worktrees/*` path; `getProjectRepoRoot` self-heals from live terminal cwds.
  const projectRoot = (activeProject && getProjectRepoRoot(activeProject)) || activeProject?.defaultCwd || ''

  const [tree, setTree] = useState<FolderTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [confirmDeleteModal, setConfirmDeleteModal] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [backups, setBackups] = useState<BackupArchiveEntry[]>([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [creatingBackup, setCreatingBackup] = useState(false)

  const reloadBackups = () => {
    if (!projectRoot) return
    setBackupsLoading(true)
    listProjectBackups(projectRoot)
      .then(setBackups)
      .catch((e) => pushToast({ title: 'Erro', body: String(e) }))
      .finally(() => setBackupsLoading(false))
  }

  useEffect(() => {
    reloadBackups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject])

  useEffect(() => {
    if (!projectRoot) return
    setLoading(true)
    scanProjectFolderTree(projectRoot)
      .then((nodes) => {
        setTree(nodes)
        // Auto-seleciona de forma inteligente: todos os itens essenciais e leves, preservando a integridade do projeto
        const initialSelected = new Set<string>()
        const collectSafe = (list: FolderTreeNode[]) => {
          for (const item of list) {
            // Itens essenciais (lockfiles, manifestos, configs) são SEMPRE selecionados
            if (item.isEssential || !item.isHeavy) {
              initialSelected.add(item.path)
            }
            if (item.children.length > 0) {
              collectSafe(item.children)
            }
          }
        }
        collectSafe(nodes)
        setSelectedPaths(initialSelected)
      })
      .catch((e) => pushToast({ title: 'Erro', body: String(e) }))
      .finally(() => setLoading(false))
  }, [activeProject, pushToast])

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Desmarca apenas caches/build outputs pesados, garantindo que nada essencial seja perdido
  const deselectHeavyCaches = () => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      const uncheck = (list: FolderTreeNode[]) => {
        for (const item of list) {
          if (item.isHeavy && !item.isEssential) {
            next.delete(item.path)
          }
          if (item.children.length > 0) uncheck(item.children)
        }
      }
      uncheck(tree)
      return next
    })
    pushToast({
      title: 'Cofre Inteligente',
      body: 'Caches e saídas de build descartáveis foram desmarcados. Todos os manifestos e arquivos essenciais foram preservados!',
    })
  }

  const selectAll = () => {
    const all = new Set<string>()
    const collectAll = (list: FolderTreeNode[]) => {
      for (const item of list) {
        all.add(item.path)
        if (item.children.length > 0) collectAll(item.children)
      }
    }
    collectAll(tree)
    setSelectedPaths(all)
  }

  const deselectAll = () => {
    setSelectedPaths(new Set())
  }

  // Stats calculation
  const stats = useMemo(() => {
    let totalItems = 0
    let totalBytes = 0
    let selectedCount = 0
    let selectedBytes = 0
    let heavyCount = 0
    let heavyBytes = 0
    let essentialCount = 0
    let essentialBytes = 0

    const traverse = (list: FolderTreeNode[]) => {
      for (const item of list) {
        totalItems++
        if (!item.isDir) totalBytes += item.sizeBytes
        const isSelected = selectedPaths.has(item.path)
        if (isSelected) {
          selectedCount++
          if (!item.isDir) selectedBytes += item.sizeBytes
        }
        if (item.isEssential) {
          essentialCount++
          if (!item.isDir) essentialBytes += item.sizeBytes
        } else if (item.isHeavy) {
          heavyCount++
          if (!item.isDir) heavyBytes += item.sizeBytes
        }
        if (item.children.length > 0) {
          traverse(item.children)
        }
      }
    }
    traverse(tree)
    return {
      totalItems,
      totalBytes,
      selectedCount,
      selectedBytes,
      heavyCount,
      heavyBytes,
      essentialCount,
      essentialBytes,
    }
  }, [tree, selectedPaths])

  // Filter nodes according to search and mode
  const filteredTree = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()

    const filterNode = (node: FolderTreeNode): FolderTreeNode | null => {
      const isSelected = selectedPaths.has(node.path)
      const isHeavy = node.isHeavy && !node.isEssential
      const isEssential = Boolean(node.isEssential)

      let matchesMode = true
      if (filterMode === 'essential') matchesMode = isEssential
      else if (filterMode === 'heavy') matchesMode = isHeavy
      else if (filterMode === 'selected') matchesMode = isSelected

      const matchesQuery = !query || node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)

      const filteredChildren: FolderTreeNode[] = []
      for (const child of node.children) {
        const matchingChild = filterNode(child)
        if (matchingChild) filteredChildren.push(matchingChild)
      }

      if ((matchesMode && matchesQuery) || filteredChildren.length > 0) {
        return {
          ...node,
          children: filteredChildren,
        }
      }
      return null
    }

    const result: FolderTreeNode[] = []
    for (const node of tree) {
      const filtered = filterNode(node)
      if (filtered) result.push(filtered)
    }
    return result
  }, [tree, selectedPaths, filterMode, searchQuery])

  const handleCreateBackup = async () => {
    if (!activeProject || !projectRoot) return
    setCreatingBackup(true)
    try {
      await triggerProjectArchiveBackup(projectRoot, activeProject.name)
      reloadBackups()
      pushToast({ title: 'Sucesso', body: 'Backup definitivo e imutável gravado no cofre!' })
    } catch (e) {
      pushToast({ title: 'Erro', body: `Falha ao gravar backup: ${e}` })
    } finally {
      setCreatingBackup(false)
    }
  }

  const handlePurgeVault = async () => {
    if (!activeProject || !projectRoot) return
    try {
      await purgeProjectBackupsSecured(projectRoot, activeProject.name, confirmInput)
      setBackups([])
      setConfirmDeleteModal(false)
      setConfirmInput('')
      pushToast({ title: 'Cofre', body: 'Histórico do cofre de backups foi purgado.' })
    } catch (e) {
      pushToast({ title: 'Erro', body: String(e) })
    }
  }

  const formatBackupDate = (createdAtSecs: number) =>
    new Date(createdAtSecs * 1000).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  const renderTree = (nodes: FolderTreeNode[]) => {
    return nodes.map((node) => {
      const isSelected = selectedPaths.has(node.path)
      const isExpanded = expandedPaths.has(node.path)
      const hasChildren = node.children.length > 0
      const isHeavy = node.isHeavy && !node.isEssential
      const isEssential = Boolean(node.isEssential)

      return (
        <div key={node.path} className={styles.treeItemRow}>
          <div className={styles.nodeItem}>
            {hasChildren ? (
              <button
                type="button"
                className={styles.expandBtn}
                onClick={() => toggleExpand(node.path)}
              >
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : (
              <span className={styles.expandPlaceholder} />
            )}

            <button
              type="button"
              className={styles.checkboxBtn}
              onClick={() => toggleSelect(node.path)}
            >
              {isSelected ? (
                <CheckSquare size={14} className={styles.checkIconActive} />
              ) : (
                <Square size={14} className={styles.checkIconInactive} />
              )}
            </button>

            {getNodeIcon(node)}

            <span
              className={`${styles.nodeName} ${isEssential ? styles.nodeNameEssential : isHeavy ? styles.nodeNameHeavy : ''}`}
            >
              {node.name}
            </span>

            <div className={styles.nodeMeta}>
              {node.sizeBytes > 0 ? (
                <span className={`${styles.nodeSize} ${isHeavy ? styles.nodeSizeHeavy : ''}`}>
                  {formatBytes(node.sizeBytes)}
                </span>
              ) : null}

              {isEssential ? (
                <span className={styles.essentialBadge} title="Arquivo/Manifesto crítico indispensável para build e execução">
                  Essencial
                </span>
              ) : isHeavy ? (
                <span className={styles.heavyBadge}>
                  {node.isDir ? 'Cache / Build' : 'Binário Descartável'}
                </span>
              ) : null}
            </div>
          </div>

          {isExpanded && hasChildren ? (
            <div className={styles.treeChildren}>{renderTree(node.children)}</div>
          ) : null}
        </div>
      )
    })
  }

  return (
    <div className={styles.backdrop} onClick={() => closeModal()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <div className={styles.titleGroup}>
            <FolderSync size={16} className={styles.headerIcon} />
            <strong className={styles.modalTitle}>Configuração de Sincronização & Cofre</strong>
          </div>
          <button type="button" className={styles.closeBtn} onClick={() => closeModal()}>
            <X size={15} />
          </button>
        </header>

        <div className={styles.modalBody}>
          <div className={styles.encapsulationNotice}>
            <Lock size={14} className={styles.lockIcon} />
            <span>
              <strong>Isolamento Garantido:</strong> O projeto sempre será salvo na pasta dedicada{' '}
              <code>/{activeProject?.name || 'projeto'}/</code> no PC de destino com a pasta{' '}
              <code>.alethe/</code> oculta.
            </span>
          </div>

          {/* Quick Metrics Bar */}
          <div className={styles.metricsBar}>
            <div className={styles.metricItem}>
              <span className={styles.metricLabel}>Selecionados:</span>
              <strong className={styles.metricValue}>
                {stats.selectedCount} ({formatBytes(stats.selectedBytes)})
              </strong>
            </div>
            <div className={styles.metricDivider} />
            <div className={styles.metricItem}>
              <span className={styles.metricLabel}>Essenciais:</span>
              <span className={styles.metricValueEssential}>
                {stats.essentialCount} ({formatBytes(stats.essentialBytes)})
              </span>
            </div>
            <div className={styles.metricDivider} />
            <div className={styles.metricItem}>
              <span className={styles.metricLabel}>Caches/Pesados:</span>
              <span className={`${styles.metricValue} ${stats.heavyCount > 0 ? styles.metricValueWarning : ''}`}>
                {stats.heavyCount} ({formatBytes(stats.heavyBytes)})
              </span>
            </div>
          </div>

          <div className={styles.treeSection}>
            <div className={styles.treeHeader}>
              <div className={styles.filterTabs}>
                <button
                  type="button"
                  className={`${styles.filterTab} ${filterMode === 'all' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterMode('all')}
                >
                  Todos ({stats.totalItems})
                </button>
                <button
                  type="button"
                  className={`${styles.filterTab} ${filterMode === 'essential' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterMode('essential')}
                >
                  <Sparkles size={11} className={styles.tabIconEssential} />
                  Essenciais ({stats.essentialCount})
                </button>
                <button
                  type="button"
                  className={`${styles.filterTab} ${filterMode === 'heavy' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterMode('heavy')}
                >
                  <Filter size={11} />
                  Caches/Pesados ({stats.heavyCount})
                </button>
                <button
                  type="button"
                  className={`${styles.filterTab} ${filterMode === 'selected' ? styles.filterTabActive : ''}`}
                  onClick={() => setFilterMode('selected')}
                >
                  Selecionados ({stats.selectedCount})
                </button>
              </div>

              <div className={styles.actionButtons}>
                <button
                  type="button"
                  className={styles.actionBtnWarning}
                  title="Desmarca node_modules, target, builds e arquivos pesados descartáveis preservando todos os manifestos e arquivos essenciais"
                  onClick={deselectHeavyCaches}
                >
                  Desmarcar Apenas Caches
                </button>
                <button type="button" className={styles.presetBtn} onClick={selectAll}>
                  Selecionar Tudo
                </button>
                <button type="button" className={styles.presetBtn} onClick={deselectAll}>
                  Limpar
                </button>
              </div>
            </div>

            {/* Search Input */}
            <div className={styles.searchBar}>
              <Search size={13} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                value={searchQuery}
                placeholder="Filtrar arquivos ou pastas..."
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className={styles.clearSearchBtn}
                  onClick={() => setSearchQuery('')}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>

            <div className={styles.treeContainer}>
              {loading ? (
                <div className={styles.loadingRow}>
                  <RefreshCw size={14} className={styles.spin} />
                  <span>Escaneando pastas e identificando arquivos essenciais...</span>
                </div>
              ) : filteredTree.length === 0 ? (
                <div className={styles.emptyState}>
                  <span>Nenhum arquivo ou pasta encontrado para os filtros atuais.</span>
                </div>
              ) : (
                renderTree(filteredTree)
              )}
            </div>
          </div>

          <div className={styles.vaultSection}>
            <div className={styles.vaultHeader}>
              <div className={styles.vaultTitleGroup}>
                <Archive size={14} className={styles.vaultIcon} />
                <span className={styles.sectionLabel}>Cofre de Backups Definitivos (WORM)</span>
              </div>
              <span className={styles.vaultCountBadge}>
                {backupsLoading ? '…' : backups.length} Snapshots Imutáveis
              </span>
            </div>

            <div className={styles.vaultActions}>
              <button
                type="button"
                className={styles.backupBtn}
                disabled={creatingBackup}
                onClick={handleCreateBackup}
              >
                {creatingBackup ? (
                  <RefreshCw size={13} className={styles.spin} />
                ) : (
                  <HardDrive size={13} />
                )}
                <span>Gerar Ponto de Restauração Agora</span>
              </button>
              <button
                type="button"
                className={styles.purgeBtn}
                disabled={backups.length === 0}
                onClick={() => setConfirmDeleteModal(true)}
              >
                <Trash2 size={13} />
                <span>Limpar Histórico do Cofre...</span>
              </button>
            </div>

            {backupsLoading ? (
              <div className={styles.loadingRow}>
                <RefreshCw size={14} className={styles.spin} />
                <span>Carregando snapshots do cofre...</span>
              </div>
            ) : backups.length > 0 ? (
              <ul className={styles.backupList}>
                {backups.map((entry) => (
                  <li key={entry.filename} className={styles.backupRow}>
                    <Archive size={12} className={styles.backupRowIcon} />
                    <div className={styles.backupRowInfo}>
                      <span className={styles.backupRowDate}>{formatBackupDate(entry.createdAt)}</span>
                      <span className={styles.backupRowHash} title={entry.sha256}>
                        sha256:{entry.sha256.slice(0, 12)}…
                      </span>
                    </div>
                    <span className={styles.backupRowSize}>{formatBytes(entry.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {confirmDeleteModal ? (
          <div className={styles.criticalOverlay}>
            <div className={styles.criticalCard}>
              <div className={styles.criticalHeader}>
                <AlertTriangle size={20} className={styles.criticalIcon} />
                <strong>AVISO CRÍTICO DE SEGURANÇA</strong>
              </div>
              <p className={styles.criticalDesc}>
                Este cofre é a sua <strong>última linha de defesa</strong> contra perda irreversível de
                código ou sobrescritas por outros computadores. Deseja realmente excluir todos os
                backups?
              </p>
              <div className={styles.confirmPrompt}>
                <span>Digite o nome do projeto (<code>{activeProject?.name}</code>) para confirmar:</span>
                <input
                  type="text"
                  className={styles.confirmInput}
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={activeProject?.name}
                />
              </div>
              <div className={styles.criticalActions}>
                <button
                  type="button"
                  className={styles.cancelCritBtn}
                  onClick={() => setConfirmDeleteModal(false)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className={styles.deleteCritBtn}
                  disabled={confirmInput.trim() !== activeProject?.name}
                  onClick={handlePurgeVault}
                >
                  Confirmar Exclusão Permanente
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

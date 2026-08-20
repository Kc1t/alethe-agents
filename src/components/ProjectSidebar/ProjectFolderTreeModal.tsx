import {
  AlertTriangle,
  Archive,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderSync,
  HardDrive,
  Lock,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  type FolderTreeNode,
  purgeProjectBackupsSecured,
  scanProjectFolderTree,
  triggerProjectArchiveBackup,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './ProjectFolderTreeModal.module.css'

export function ProjectFolderTreeModal() {
  const closeModal = useUiStore((s) => s.closeModal)
  const pushToast = useUiStore((s) => s.pushToast)
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]

  const [tree, setTree] = useState<FolderTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [confirmDeleteModal, setConfirmDeleteModal] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [vaultBackupsCount, setVaultBackupsCount] = useState(3)

  useEffect(() => {
    if (!activeProject?.defaultCwd) return
    setLoading(true)
    scanProjectFolderTree(activeProject.defaultCwd)
      .then((nodes) => {
        setTree(nodes)
        // Auto-seleciona pastas leves e desmarca heavy (node_modules, target, .env)
        const initialSelected = new Set<string>()
        const collectLight = (list: FolderTreeNode[]) => {
          for (const item of list) {
            if (!item.isHeavy) {
              initialSelected.add(item.path)
            }
            if (item.children.length > 0) {
              collectLight(item.children)
            }
          }
        }
        collectLight(nodes)
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

  const deselectHeavy = () => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      const uncheck = (list: FolderTreeNode[]) => {
        for (const item of list) {
          if (item.isHeavy) next.delete(item.path)
          if (item.children.length > 0) uncheck(item.children)
        }
      }
      uncheck(tree)
      return next
    })
  }

  const handleCreateBackup = async () => {
    if (!activeProject?.defaultCwd) return
    try {
      await triggerProjectArchiveBackup(activeProject.defaultCwd, activeProject.name)
      setVaultBackupsCount((c) => c + 1)
      pushToast({ title: 'Sucesso', body: 'Backup definitivo e imutável gravado no cofre!' })
    } catch (e) {
      pushToast({ title: 'Erro', body: `Falha ao gravar backup: ${e}` })
    }
  }

  const handlePurgeVault = async () => {
    if (!activeProject?.defaultCwd) return
    try {
      await purgeProjectBackupsSecured(activeProject.defaultCwd, activeProject.name, confirmInput)
      setVaultBackupsCount(0)
      setConfirmDeleteModal(false)
      setConfirmInput('')
      pushToast({ title: 'Cofre', body: 'Histórico do cofre de backups foi purgado.' })
    } catch (e) {
      pushToast({ title: 'Erro', body: String(e) })
    }
  }

  const renderTree = (nodes: FolderTreeNode[]) => {
    return nodes.map((node) => {
      const isSelected = selectedPaths.has(node.path)
      const isExpanded = expandedPaths.has(node.path)
      const hasChildren = node.children.length > 0

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

            <Folder size={13} className={node.isHeavy ? styles.folderHeavy : styles.folderNormal} />
            <span className={`${styles.nodeName} ${node.isHeavy ? styles.nodeNameHeavy : ''}`}>
              {node.name}
            </span>
            {node.isHeavy ? <span className={styles.heavyBadge}>Ignorado por Padrão</span> : null}
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

          <div className={styles.treeSection}>
            <div className={styles.treeHeader}>
              <span className={styles.sectionLabel}>Pastas para Sincronizar ({selectedPaths.size} selecionadas)</span>
              <button type="button" className={styles.presetBtn} onClick={deselectHeavy}>
                Desmarcar Pastas Pesadas
              </button>
            </div>

            <div className={styles.treeContainer}>
              {loading ? (
                <div className={styles.loadingRow}>
                  <RefreshCw size={14} className={styles.spin} />
                  <span>Escaneando pastas do projeto...</span>
                </div>
              ) : (
                renderTree(tree)
              )}
            </div>
          </div>

          <div className={styles.vaultSection}>
            <div className={styles.vaultHeader}>
              <div className={styles.vaultTitleGroup}>
                <Archive size={14} className={styles.vaultIcon} />
                <span className={styles.sectionLabel}>Cofre de Backups Definitivos (WORM)</span>
              </div>
              <span className={styles.vaultCountBadge}>{vaultBackupsCount} Snapshots Imutáveis</span>
            </div>

            <div className={styles.vaultActions}>
              <button
                type="button"
                className={styles.backupBtn}
                onClick={handleCreateBackup}
              >
                <HardDrive size={13} />
                <span>Gerar Ponto de Restauração Agora</span>
              </button>
              <button
                type="button"
                className={styles.purgeBtn}
                onClick={() => setConfirmDeleteModal(true)}
              >
                <Trash2 size={13} />
                <span>Limpar Histórico do Cofre...</span>
              </button>
            </div>
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

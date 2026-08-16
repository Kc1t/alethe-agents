import { Grid3x3, Layout, LayoutGrid, Sidebar as SidebarIcon, type LucideIcon } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { type LayoutMode } from '../../lib/types'
import {
  selectActiveContainer,
  selectActiveProject,
  useProjectsStore,
} from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './ProjectSidebar.module.css'

const LAYOUTS: { id: LayoutMode; label: string; Icon: LucideIcon }[] = [
  { id: 'auto', label: 'Auto', Icon: LayoutGrid },
  { id: 'spotlight', label: 'Spotlight', Icon: Layout },
  { id: 'sidebar', label: 'Sidebar', Icon: SidebarIcon },
  { id: 'grid', label: 'Grid', Icon: Grid3x3 },
]

export function LayoutFooter() {
  const t = useT()
  const project = useProjectsStore(selectActiveProject)
  const container = useProjectsStore(selectActiveContainer)
  const setLayoutMode = useProjectsStore((s) => s.setLayoutMode)
  if (!project || !container || container.paneIds.length < 2) return null
  return (
    <div className={styles.layoutFooter}>
      <span className={styles.layoutLabel}>{t('ui.sidebar.organization')}</span>
      <div className={styles.layoutSwitch}>
        {LAYOUTS.map((opt) => {
          const Icon = opt.Icon
          const active = container.internalLayout === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              className={`${styles.layoutBtn} ${active ? styles.layoutBtnActive : ''}`}
              onClick={() => setLayoutMode(project.id, opt.id)}
              title={opt.label}
              aria-label={opt.label}
            >
              <Icon size={14} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function WorkspaceLayoutFooter({ forceVisible = false }: { forceVisible?: boolean }) {
  const t = useT()
  const containerCount = useProjectsStore((s) => s.workspace.containers.length)
  const hasCustom = useProjectsStore((s) => Boolean(s.preferences.workspaceGridLayout))
  const openModal = useUiStore((s) => s.openModal_)
  if (!forceVisible && containerCount < 2) return null
  return (
    <div className={styles.layoutFooter}>
      <span className={styles.layoutLabel}>Workspace</span>
      <button
        type="button"
        className={`${styles.layoutBtn} ${hasCustom ? styles.layoutBtnActive : ''}`}
        onClick={() => openModal('layoutDesigner', { kind: 'workspace' })}
        title={t('ui.sidebar.designWorkspaceLayout')}
        aria-label={t('ui.sidebar.designLayoutShort')}
        style={{ width: 'auto', padding: '0 10px', fontSize: 11, gap: 6 }}
      >
        <Grid3x3 size={12} />
        <span>{hasCustom ? t('ui.sidebar.editGrid') : t('ui.sidebar.drawGrid')}</span>
      </button>
    </div>
  )
}

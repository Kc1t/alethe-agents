import { useMemo } from 'react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'

export function SuspendGroupModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'suspendGroup')
  const context = useUiStore((s) => s.modalContext) as { groupId?: string } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const suspendGroup = useProjectsStore((s) => s.suspendGroup)
  const groups = useProjectsStore((s) => s.groups)
  const projects = useProjectsStore((s) => s.projects)

  const group = useMemo(
    () => (context?.groupId ? (groups.find((g) => g.id === context.groupId) ?? null) : null),
    [context?.groupId, groups],
  )

  const { terminalCount, activeCount } = useMemo(() => {
    if (!group) return { terminalCount: 0, activeCount: 0 }
    const groupProjects = projects.filter((p) => group.projectIds.includes(p.id))
    return {
      terminalCount: groupProjects.reduce((sum, p) => sum + p.terminals.length, 0),
      activeCount: groupProjects.reduce(
        (sum, p) => sum + p.terminals.filter((item) => !item.disabled).length,
        0,
      ),
    }
  }, [group, projects])

  if (!group) return null

  const onConfirm = () => {
    suspendGroup(group.id)
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('term.suspendGroupTitle')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('term.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnDanger}`}
            onClick={onConfirm}
          >
            {t('term.suspend')}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.5, margin: '0 0 12px' }}>
        {t('term.suspendConfirmBefore')}{' '}
        <strong style={{ color: group.color }}>{group.name}</strong>
        {t('term.suspendConfirmAfter')}
      </p>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5, margin: 0 }}>
        {t('term.suspendDetail', { count: activeCount, total: terminalCount })}
      </p>
    </Modal>
  )
}

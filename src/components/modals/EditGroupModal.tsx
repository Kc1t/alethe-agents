import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { GROUP_COLORS } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { GroupFields } from './GroupFields'
import { Modal } from './Modal'

export function EditGroupModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'editGroup')
  const context = useUiStore((s) => s.modalContext) as { groupId?: string } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const renameGroup = useProjectsStore((s) => s.renameGroup)
  const setGroupColor = useProjectsStore((s) => s.setGroupColor)
  const setGroupIconUrl = useProjectsStore((s) => s.setGroupIconUrl)
  const group = useProjectsStore((s) =>
    context?.groupId ? (s.groups.find((g) => g.id === context.groupId) ?? null) : null,
  )

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [iconUrl, setIconUrl] = useState('')

  useEffect(() => {
    if (open && group) {
      setName(group.name)
      setColor(group.color)
      setIconUrl(group.iconUrl ?? '')
    }
  }, [open, group])

  if (!group) return null

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== group.name) renameGroup(group.id, trimmed)
    if (color !== group.color) setGroupColor(group.id, color)
    const trimmedUrl = iconUrl.trim()
    const newIconUrl = trimmedUrl || undefined
    if (newIconUrl !== group.iconUrl) setGroupIconUrl(group.id, newIconUrl)
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('crud.editGroupTitle')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('crud.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!name.trim()}
            onClick={submit}
          >
            {t('crud.save')}
          </button>
        </>
      }
    >
      <GroupFields
        name={name}
        color={color}
        iconUrl={iconUrl}
        onNameChange={setName}
        onColorChange={setColor}
        onIconUrlChange={setIconUrl}
        onSubmit={submit}
        nameLabel={t('crud.nameLabel')}
        colorLabel={t('crud.colorLabel')}
        colorSwatchLabel={(candidate) => t('crud.colorSwatch', { color: candidate })}
        iconLabel={t('crud.groupLogoLabel')}
        iconHint={t('crud.groupIconHint')}
        previewLabel={t('crud.groupColorPreview')}
        swatchSize={28}
      />
    </Modal>
  )
}

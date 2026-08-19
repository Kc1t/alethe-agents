import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { GROUP_COLORS } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { ImageInput } from './ImageInput'
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

  const previewIcon = iconUrl.trim()

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
      <div className={controls.field}>
        <label className={controls.label}>{t('crud.nameLabel')}</label>
        <input
          className={controls.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.colorLabel')}</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={t('crud.colorSwatch', { color: c })}
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: c,
                border: color === c ? '2px solid var(--fg)' : '2px solid transparent',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </div>

      <ImageInput
        label={t('crud.groupLogoLabel')}
        value={iconUrl}
        onChange={setIconUrl}
        onEnter={submit}
        hint={t('crud.groupIconHint')}
      />

      <div
        style={{
          marginTop: 6,
          padding: '10px 12px',
          borderRadius: 'var(--radius-md)',
          border: `2px solid color-mix(in srgb, ${color} 50%, transparent)`,
          fontSize: 11,
          color: 'var(--fg-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {previewIcon ? (
          <img
            src={previewIcon}
            alt=""
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              objectFit: 'cover',
              flexShrink: 0,
            }}
          />
        ) : (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: color,
              flexShrink: 0,
            }}
          />
        )}
        {t('crud.groupColorPreview')}
      </div>
    </Modal>
  )
}

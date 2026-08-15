import { Folder, Network, Palette, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { pickDirectory } from '../../lib/dialog'
import { AGENT_SANDBOX_ENABLED } from '../../lib/featureFlags'
import { useT } from '../../lib/i18n'
import { GROUP_COLORS } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown } from '../ui/Dropdown'
import { ColorPalettePopover } from './ColorPalettePopover'
import controls from './controls.module.css'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'

export function NewProjectModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newProject')
  const context = useUiStore((s) => s.modalContext) as {
    groupId?: string | null
    defaultCwd?: string
  } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createProject = useProjectsStore((s) => s.createProject)
  const setActiveProject = useProjectsStore((s) => s.setActiveProject)
  const openModal = useUiStore((s) => s.openModal_)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const groups = useProjectsStore((s) => s.groups)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [iconUrl, setIconUrl] = useState('')
  const [defaultCwd, setDefaultCwd] = useState('')
  const [mode, setMode] = useState<'standard' | 'agentSandbox'>('standard')
  const [groupId, setGroupId] = useState<string | null>(context?.groupId ?? null)
  const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false)

                                                                        
                                                                       
                                        
  useEffect(() => {
    if (open && context?.defaultCwd) setDefaultCwd(context.defaultCwd)
  }, [open, context?.defaultCwd])

  const reset = () => {
    setName('')
    setColor(GROUP_COLORS[0])
    setIconUrl('')
    setDefaultCwd('')
    setMode('standard')
    setGroupId(context?.groupId ?? null)
    setIsColorPopoverOpen(false)
  }

  const browse = async () => {
    const directory = await pickDirectory({ defaultPath: defaultCwd || undefined })
    if (directory) setDefaultCwd(directory)
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (mode === 'agentSandbox' && !defaultCwd.trim()) return
    const project = createProject({
      name: trimmed,
      mode,
      color,
      iconUrl: iconUrl.trim() || undefined,
      groupId,
      defaultCwd: defaultCwd.trim() || undefined,
    })
    reset()
    setActiveProject(project.id)

    if (mode === 'agentSandbox') {
      setActiveView('agentSandbox')
      closeModal()
      return
    }

    openModal('newTerminal', { projectId: project.id })
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        closeModal()
      }}
      title={t('crud.newProjectTitle')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('crud.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!name.trim() || (mode === 'agentSandbox' && !defaultCwd.trim())}
            onClick={() => void submit()}
          >
            {mode === 'agentSandbox' ? t('crud.createAgentSandboxProject') : t('crud.create')}
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
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder={t('crud.projectNamePlaceholder')}
        />
      </div>

      {AGENT_SANDBOX_ENABLED ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('crud.projectModeLabel')}</label>
          <div
            className={controls.modeChoices}
            role="radiogroup"
            aria-label={t('crud.projectModeLabel')}
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'standard'}
              className={`${controls.modeChoice} ${mode === 'standard' ? controls.modeChoiceActive : ''}`}
              onClick={() => setMode('standard')}
            >
              <Terminal size={16} aria-hidden="true" />
              <span className={controls.modeChoiceBody}>
                <strong>{t('crud.projectModeStandard')}</strong>
                <small>{t('crud.projectModeStandardHint')}</small>
              </span>
              <span className={controls.modeChoiceIndicator} aria-hidden="true" />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'agentSandbox'}
              className={`${controls.modeChoice} ${mode === 'agentSandbox' ? controls.modeChoiceActive : ''}`}
              onClick={() => setMode('agentSandbox')}
            >
              <Network size={16} aria-hidden="true" />
              <span className={controls.modeChoiceBody}>
                <strong>{t('crud.projectModeSandbox')}</strong>
                <small>{t('crud.projectModeSandboxHint')}</small>
              </span>
              <span className={controls.modeChoiceIndicator} aria-hidden="true" />
            </button>
          </div>
          <span className={controls.hint}>{t('crud.projectModeSelectionHint')}</span>
        </div>
      ) : null}

      {groups.length > 0 ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('crud.groupLabel')}</label>
          <Dropdown
            className={controls.input}
            value={groupId ?? ''}
            onChange={(value) => setGroupId(value || null)}
            ariaLabel={t('crud.groupLabel')}
            options={[
              { value: '', label: t('crud.noGroup') },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        </div>
      ) : null}

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.projectPathLabel')}</label>
        <div className={controls.cwdRow}>
          <div className={controls.cwdInputWrap}>
            <Folder size={15} aria-hidden="true" />
            <input
              className={controls.input}
              value={defaultCwd}
              onChange={(event) => setDefaultCwd(event.target.value)}
              placeholder={t('crud.projectPathPlaceholder')}
              title={defaultCwd}
            />
          </div>
          <button type="button" className={controls.btn} onClick={() => void browse()}>
            {t('term.browse')}
          </button>
        </div>
        <span className={controls.hint}>{t('crud.projectPathHint')}</span>
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.colorLabel')}</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={t('crud.colorSwatch', { color: c })}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: c,
                border: color === c ? '2px solid var(--fg)' : '2px solid transparent',
                cursor: 'pointer',
              }}
            />
          ))}

          {color && !GROUP_COLORS.some((preset) => preset === color) && (
            <button
              type="button"
              onClick={() => setIsColorPopoverOpen(true)}
              title={color}
              aria-label={t('crud.colorSwatch', { color })}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: color,
                border: '2px solid var(--fg)',
                boxShadow: '0 0 0 1px var(--bg)',
                cursor: 'pointer',
              }}
            />
          )}

          {/* Botão de Paleta Completa / Mais Cores */}
          <button
            type="button"
            onClick={() => setIsColorPopoverOpen(true)}
            title={t('crud.moreColors')}
            aria-label={t('crud.moreColors')}
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: 'var(--panel-hover)',
              border: '1px solid var(--border-strong)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
            }}
          >
            <Palette size={13} />
          </button>
        </div>
      </div>

      <ImageInput
        label={t('crud.iconLabel')}
        value={iconUrl}
        onChange={setIconUrl}
        onEnter={submit}
        previewColor={color}
        hint={t('crud.projectIconHint')}
      />

      <ColorPalettePopover
        open={isColorPopoverOpen}
        onClose={() => setIsColorPopoverOpen(false)}
        onSelectColor={(selected) => setColor(selected)}
        selectedColor={color}
      />
    </Modal>
  )
}

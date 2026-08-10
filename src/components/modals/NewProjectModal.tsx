import { Folder, GitBranch, Network, Palette, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useUiStore } from '../../stores/uiStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { AGENT_SANDBOX_ENABLED } from '../../lib/featureFlags'
import { GROUP_COLORS, type Project } from '../../lib/types'
import { useT } from '../../lib/i18n'
import { pickDirectory } from '../../lib/dialog'
import { cloneGithubRepo, readProjectMarker } from '../../lib/tauri'
import { ColorPalettePopover } from './ColorPalettePopover'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'
import controls from './controls.module.css'
import { Dropdown } from '../ui/Dropdown'

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
  const pushToast = useUiStore((s) => s.pushToast)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const groups = useProjectsStore((s) => s.groups)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [iconUrl, setIconUrl] = useState('')
  const [defaultCwd, setDefaultCwd] = useState('')
  const [githubUrl, setGithubUrl] = useState('')
  const [mode, setMode] = useState<'standard' | 'agentSandbox'>('standard')
  const [groupId, setGroupId] = useState<string | null>(context?.groupId ?? null)
  const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false)
  const [detectedConfig, setDetectedConfig] = useState<Project | null>(null)

  // Herda a pasta já escolhida na tela "Nenhum projeto aberto" quando o
  // usuário troca pro formulário completo em vez de perder a seleção e
  // obrigar a escolher a pasta de novo.
  useEffect(() => {
    if (open && context?.defaultCwd) setDefaultCwd(context.defaultCwd)
  }, [open, context?.defaultCwd])

  const reset = () => {
    setName('')
    setColor(GROUP_COLORS[0])
    setIconUrl('')
    setDefaultCwd('')
    setGithubUrl('')
    setMode('standard')
    setGroupId(context?.groupId ?? null)
    setIsColorPopoverOpen(false)
    setDetectedConfig(null)
  }

  const checkForDetectedConfig = async (directory: string) => {
    setDetectedConfig(null)
    try {
      const raw = await readProjectMarker(directory)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<Project>
      if (parsed && typeof parsed.name === 'string' && Array.isArray(parsed.terminals)) {
        setDetectedConfig(parsed as Project)
      }
    } catch {
      /* marcador ausente/corrompido — segue o fluxo normal de criação */
    }
  }

  const browse = async () => {
    const directory = await pickDirectory({ defaultPath: defaultCwd || undefined })
    if (!directory) return
    setDefaultCwd(directory)
    void checkForDetectedConfig(directory)
  }

  const restoreDetected = () => {
    if (!detectedConfig) return
    const project = useProjectsStore.getState().importProjectFromFile(detectedConfig, groupId)
    setActiveProject(project.id)
    closeModal()
    reset()
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (mode === 'agentSandbox' && !defaultCwd.trim()) return
    // Clone e Agent Sandbox são mutuamente exclusivos: o sandbox exige uma
    // pasta que já exista no disco.
    const trimmedGithub = mode === 'agentSandbox' ? '' : githubUrl.trim()
    const project = createProject({
      name: trimmed,
      mode,
      color,
      iconUrl: iconUrl.trim() || undefined,
      groupId,
      // Clonar dita a pasta do projeto — ignora o path escolhido manualmente.
      defaultCwd: trimmedGithub ? undefined : defaultCwd.trim() || undefined,
      githubUrl: trimmedGithub || undefined,
      firstBootPending: Boolean(trimmedGithub),
    })
    reset()
    setActiveProject(project.id)

    if (mode === 'agentSandbox') {
      setActiveView('agentSandbox')
      closeModal()
      return
    }

    if (trimmedGithub) {
      closeModal()
      pushToast({
        title: 'Clonando Repositório',
        body: `Iniciando clone de ${trimmedGithub} e gerando briefing de contexto de IA...`,
        agent: 'claude',
      })
      try {
        // A pasta escolhida (se houver) vira o pai do clone; string vazia deixa
        // o backend resolver o padrao. O nome da pasta sai da URL do repo.
        await cloneGithubRepo(trimmedGithub, defaultCwd.trim())
        pushToast({
          title: 'Repositório Clonado',
          body: 'Clone concluído com sucesso. Contexto de IA injetado em AGENTS.md e CLAUDE.md.',
          agent: 'claude',
        })
      } catch (err) {
        console.error('Falha ao clonar repositório GitHub:', err)
        pushToast({
          title: 'Erro no Clone',
          body: String(err),
          agent: 'claude',
        })
      }
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
          <div className={controls.modeChoices} role="radiogroup" aria-label={t('crud.projectModeLabel')}>
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
          <span className={controls.hint}>
            {t('crud.projectModeSelectionHint')}
          </span>
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
            options={[{ value: '', label: t('crud.noGroup') }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
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
        {detectedConfig ? (
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--accent)',
              background: 'var(--accent-faint)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 11,
            }}
          >
            <span>{t('crud.detectedConfigFound', { name: detectedConfig.name })}</span>
            <button type="button" className={controls.btn} onClick={restoreDetected}>
              {t('crud.detectedConfigRestore')}
            </button>
          </div>
        ) : null}
      </div>

      <div className={controls.field}>
        <label className={controls.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <GitBranch size={12} />
          <span>{t('crud.githubUrlLabel')}</span>
        </label>
        <input
          className={controls.input}
          value={githubUrl}
          onChange={(e) => setGithubUrl(e.target.value)}
          placeholder="https://github.com/usuario/repositorio"
        />
        <span className={controls.hint}>{t('crud.githubUrlHint')}</span>
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

          {/* Cor customizada ativa (se não estiver nos presets do GROUP_COLORS e não for rainbow) */}
          {color && !GROUP_COLORS.includes(color as any) && color !== 'rgb-rainbow' && (
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

          {/* Opção Arco-Íris Infinito (Rainbow RGB) */}
          <button
            type="button"
            onClick={() => setColor('rgb-rainbow')}
            title="Arco-Íris Infinito (RGB)"
            className="swatch-rgb-rainbow"
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              border: color === 'rgb-rainbow' ? '2px solid var(--fg)' : '2px solid transparent',
              cursor: 'pointer',
            }}
          />
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

import { convertFileSrc } from '@tauri-apps/api/core'
import { Bot } from 'lucide-react'
import { useState } from 'react'

import { isAgentEnabled } from '../../../lib/agentProviders'
import {
  CUSTOM_AGENT_ACCENT_TOKENS,
  CUSTOM_AGENT_ICON_KEYS,
  iconFileImportError,
  isValidImageIconUrl,
  normalizeCustomAgentId,
  type CustomAgentValidationError,
  toCustomAgentDefinition,
  validateCustomAgent,
} from '../../../lib/customAgents'
import {
  importCustomAgentIconAsset,
  invalidateCustomAgentIconAsset,
  isCustomIconFileAvailable,
} from '../../../lib/customAgentIconAssets'
import { pickFile } from '../../../lib/dialog'
import { type MessageKey, useT } from '../../../lib/i18n'
import type { CustomAgentDefinition, CustomAgentIconSpec } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { customAgentIconComponent } from '../../icons/customAgentIcons'
import styles from './CustomAgentsSection.module.css'

const ERROR_KEY: Record<CustomAgentValidationError, MessageKey> = {
  idFormat: 'prefs.customAgentErrorIdFormat',
  idTaken: 'prefs.customAgentErrorIdTaken',
  idBuiltin: 'prefs.customAgentErrorIdBuiltin',
  labelEmpty: 'prefs.customAgentErrorLabelEmpty',
  cliEmpty: 'prefs.customAgentErrorCliEmpty',
  cliUnsafe: 'prefs.customAgentErrorCliUnsafe',
  iconFile: 'prefs.customAgentErrorIconFile',
  iconFileTooLarge: 'prefs.customAgentErrorIconFileTooLarge',
  iconFileNotSquare: 'prefs.customAgentErrorIconFileNotSquare',
  iconFileInvalid: 'prefs.customAgentErrorIconFileInvalid',
  iconUrl: 'prefs.customAgentErrorIconUrl',
}

type IconMode = 'preset' | 'file' | 'url'

type FormState = {
  id: string
  label: string
  cliCommand: string
  unrestrictedFlag: string
  accentToken: string
  iconMode: IconMode
  iconPreset: string
  iconUrl: string
  iconFilePath: string | null
  hasStoredFileIcon: boolean
}

const EMPTY_FORM: FormState = {
  id: '',
  label: '',
  cliCommand: '',
  unrestrictedFlag: '',
  accentToken: '--agent-shell',
  iconMode: 'preset',
  iconPreset: 'bot',
  iconUrl: '',
  iconFilePath: null,
  hasStoredFileIcon: false,
}

function formFromDefinition(definition: CustomAgentDefinition): FormState {
  const spec = definition.iconSpec
  if (spec?.kind === 'url') {
    return { ...EMPTY_FORM, ...baseFromDefinition(definition), iconMode: 'url', iconUrl: spec.href }
  }
  if (spec?.kind === 'file') {
    return {
      ...EMPTY_FORM,
      ...baseFromDefinition(definition),
      iconMode: 'file',
      hasStoredFileIcon: true,
    }
  }
  return {
    ...EMPTY_FORM,
    ...baseFromDefinition(definition),
    iconMode: 'preset',
    iconPreset: spec?.kind === 'preset' ? spec.key : (definition.icon ?? 'bot'),
  }
}

function baseFromDefinition(definition: CustomAgentDefinition) {
  return {
    id: definition.id,
    label: definition.label,
    cliCommand: definition.cliCommand,
    unrestrictedFlag: definition.unrestrictedFlag ?? '',
    accentToken: definition.accentToken ?? '--agent-shell',
  }
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

function PickedFilePreview({ path }: { path: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Bot size={20} />
  return (
    <img
      src={convertFileSrc(path)}
      alt=""
      width={20}
      height={20}
      draggable={false}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

function IconPreview({ form, agentId }: { form: FormState; agentId: string }) {
  if (form.iconMode === 'url') {
    if (!isValidImageIconUrl(form.iconUrl)) return <Bot size={20} />
    const Preview = customAgentIconComponent({ kind: 'url', href: form.iconUrl.trim() })
    return <Preview size={20} />
  }
  if (form.iconMode === 'file') {
    if (form.iconFilePath) return <PickedFilePreview path={form.iconFilePath} />
    if (form.hasStoredFileIcon && agentId) {
      const Preview = customAgentIconComponent({ kind: 'file', assetId: agentId })
      return <Preview size={20} />
    }
    return <Bot size={20} />
  }
  const Preview = customAgentIconComponent({ kind: 'preset', key: form.iconPreset })
  return <Preview size={20} />
}

export function CustomAgentsSection({ enabledCount }: { enabledCount: number }) {
  const t = useT()
  const customAgents = useProjectsStore((state) => state.preferences.customAgents)
  const enabledAgents = useProjectsStore((state) => state.preferences.enabledAgents)
  const setAgentEnabled = useProjectsStore((state) => state.setAgentEnabled)
  const addCustomAgent = useProjectsStore((state) => state.addCustomAgent)
  const updateCustomAgent = useProjectsStore((state) => state.updateCustomAgent)
  const removeCustomAgent = useProjectsStore((state) => state.removeCustomAgent)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const [saving, setSaving] = useState(false)

  const fileIconsAvailable = isCustomIconFileAvailable()

  const openAdd = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setErrorKey(null)
    setFormOpen(true)
  }

  const openEdit = (definition: CustomAgentDefinition) => {
    setEditingId(definition.id)
    setForm(formFromDefinition(definition))
    setErrorKey(null)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
    setErrorKey(null)
    setSaving(false)
  }

  const onPickIco = async () => {
    const picked = await pickFile({
      title: t('prefs.customAgentIconPick'),
      filters: [{ name: 'Icons', extensions: ['ico'] }],
    })
    if (!picked) return
    if (!picked.toLowerCase().endsWith('.ico')) {
      setErrorKey(ERROR_KEY.iconFile)
      return
    }
    setErrorKey(null)
    setField('iconFilePath', picked)
  }

  const buildIconSpec = (agentId: string): CustomAgentIconSpec => {
    if (form.iconMode === 'url') return { kind: 'url', href: form.iconUrl.trim() }
    if (form.iconMode === 'file') return { kind: 'file', assetId: agentId }
    return { kind: 'preset', key: form.iconPreset }
  }

  const onSave = async () => {
    if (saving) return
    const agentId = normalizeCustomAgentId(form.id)
    if (form.iconMode === 'file' && !fileIconsAvailable) {
      setErrorKey(ERROR_KEY.iconFile)
      return
    }
    if (form.iconMode === 'file' && !form.iconFilePath && !form.hasStoredFileIcon) {
      setErrorKey(ERROR_KEY.iconFile)
      return
    }
    const iconSpec = buildIconSpec(agentId)
    const existingIds = customAgents.map((item) => item.id)
    const error = validateCustomAgent(
      {
        id: form.id,
        label: form.label,
        cliCommand: form.cliCommand,
        unrestrictedFlag: form.unrestrictedFlag || null,
        accentToken: form.accentToken,
        icon: form.iconMode === 'preset' ? form.iconPreset : 'bot',
        iconSpec,
      },
      existingIds,
      editingId ?? undefined,
    )
    if (error) {
      setErrorKey(ERROR_KEY[error])
      return
    }
    if (form.iconMode === 'file' && form.iconFilePath) {
      setSaving(true)
      try {
        await importCustomAgentIconAsset(form.iconFilePath, agentId)
      } catch (failure) {
        setSaving(false)
        setErrorKey(ERROR_KEY[iconFileImportError(failure)])
        return
      }
    }
    const definition = toCustomAgentDefinition({
      id: form.id,
      label: form.label,
      cliCommand: form.cliCommand,
      unrestrictedFlag: form.unrestrictedFlag || null,
      accentToken: form.accentToken,
      icon: form.iconMode === 'preset' ? form.iconPreset : 'bot',
      iconSpec,
    })
    if (editingId) updateCustomAgent(editingId, definition)
    else addCustomAgent(definition)
    invalidateCustomAgentIconAsset(definition.id)
    closeForm()
  }

  const onRemove = (definition: CustomAgentDefinition) => {
    if (!window.confirm(t('prefs.customAgentConfirmRemove', { label: definition.label }))) return
    removeCustomAgent(definition.id)
    invalidateCustomAgentIconAsset(definition.id)
    if (editingId === definition.id) closeForm()
  }

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const previewAgentId =
    editingId ?? (normalizeCustomAgentId(form.id) || form.id.trim().toLowerCase())

  return (
    <div className={styles.section}>
      {customAgents.length === 0 && !formOpen ? (
        <p className={styles.empty}>{t('prefs.customAgentsEmpty')}</p>
      ) : null}
      {customAgents.map((definition) => {
        const checked = isAgentEnabled(enabledAgents, definition.id)
        const disableToggle = checked && enabledCount === 1
        const Icon = customAgentIconComponent(definition.iconSpec ?? definition.icon ?? 'bot')
        return (
          <div key={definition.id} className={styles.row}>
            <span className={styles.icon}>
              <Icon size={20} />
            </span>
            <span className={styles.copy}>
              <strong>{definition.label}</strong>
              <span title={definition.cliCommand}>{definition.cliCommand}</span>
            </span>
            <span className={styles.actions}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disableToggle}
                aria-label={definition.label}
                onChange={(event) => setAgentEnabled(definition.id, event.target.checked)}
              />
              <button type="button" onClick={() => openEdit(definition)}>
                {t('prefs.customAgentEdit')}
              </button>
              <button type="button" onClick={() => onRemove(definition)}>
                {t('prefs.customAgentRemove')}
              </button>
            </span>
          </div>
        )
      })}
      {formOpen ? (
        <div className={styles.form}>
          <label className={styles.field}>
            <span>{t('prefs.customAgentId')}</span>
            <input
              value={form.id}
              disabled={editingId !== null}
              onChange={(event) => setField('id', event.target.value)}
              placeholder="my-agent"
              autoComplete="off"
              spellCheck={false}
            />
            <p className={styles.hint}>{t('prefs.customAgentIdHint')}</p>
          </label>
          <label className={styles.field}>
            <span>{t('prefs.customAgentLabel')}</span>
            <input
              value={form.label}
              onChange={(event) => setField('label', event.target.value)}
              maxLength={48}
              autoComplete="off"
            />
          </label>
          <label className={styles.field}>
            <span>{t('prefs.customAgentCli')}</span>
            <input
              value={form.cliCommand}
              onChange={(event) => setField('cliCommand', event.target.value)}
              placeholder="my-agent --chat"
              autoComplete="off"
              spellCheck={false}
            />
            <p className={styles.hint}>{t('prefs.customAgentCliHint')}</p>
          </label>
          <label className={styles.field}>
            <span>{t('prefs.customAgentFlag')}</span>
            <input
              value={form.unrestrictedFlag}
              onChange={(event) => setField('unrestrictedFlag', event.target.value)}
              placeholder="--allow-all"
              autoComplete="off"
              spellCheck={false}
            />
            <p className={styles.hint}>{t('prefs.customAgentFlagHint')}</p>
          </label>
          <div className={styles.grid2}>
            <label className={styles.field}>
              <span>{t('prefs.customAgentAccent')}</span>
              <select
                value={form.accentToken}
                onChange={(event) => setField('accentToken', event.target.value)}
              >
                {CUSTOM_AGENT_ACCENT_TOKENS.map((token) => (
                  <option key={token} value={token}>
                    {token}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.field}>
              <span>{t('prefs.customAgentIconPreview')}</span>
              <span className={styles.previewBox}>
                <IconPreview form={form} agentId={previewAgentId} />
              </span>
            </div>
          </div>
          <div className={styles.iconModes} role="radiogroup" aria-label={t('prefs.customAgentIconMode')}>
            <span className={styles.iconModesLabel}>{t('prefs.customAgentIconMode')}</span>
            <label className={styles.radioRow}>
              <input
                type="radio"
                name="custom-agent-icon-mode"
                checked={form.iconMode === 'preset'}
                onChange={() => setField('iconMode', 'preset')}
              />
              <span>{t('prefs.customAgentIconPreset')}</span>
            </label>
            <label className={styles.radioRow}>
              <input
                type="radio"
                name="custom-agent-icon-mode"
                checked={form.iconMode === 'file'}
                disabled={!fileIconsAvailable}
                onChange={() => setField('iconMode', 'file')}
              />
              <span>{t('prefs.customAgentIconFile')}</span>
            </label>
            <label className={styles.radioRow}>
              <input
                type="radio"
                name="custom-agent-icon-mode"
                checked={form.iconMode === 'url'}
                onChange={() => setField('iconMode', 'url')}
              />
              <span>{t('prefs.customAgentIconUrl')}</span>
            </label>
          </div>
          {form.iconMode === 'preset' ? (
            <label className={styles.field}>
              <span>{t('prefs.customAgentIcon')}</span>
              <select
                value={form.iconPreset}
                onChange={(event) => setField('iconPreset', event.target.value)}
              >
                {CUSTOM_AGENT_ICON_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {form.iconMode === 'file' ? (
            <div className={styles.field}>
              <span>{t('prefs.customAgentIcon')}</span>
              {fileIconsAvailable ? (
                <>
                  <button type="button" className={styles.pickButton} onClick={() => void onPickIco()}>
                    {t('prefs.customAgentIconPick')}
                  </button>
                  {form.iconFilePath ? (
                    <p className={styles.hint}>{fileNameOf(form.iconFilePath)}</p>
                  ) : form.hasStoredFileIcon ? (
                    <p className={styles.hint}>{t('prefs.customAgentIconFileKept')}</p>
                  ) : null}
                  <p className={styles.hint}>{t('prefs.customAgentIconFileHint')}</p>
                </>
              ) : (
                <p className={styles.hint}>{t('prefs.customAgentIconUnavailable')}</p>
              )}
            </div>
          ) : null}
          {form.iconMode === 'url' ? (
            <label className={styles.field}>
              <span>{t('prefs.customAgentIcon')}</span>
              <input
                value={form.iconUrl}
                onChange={(event) => setField('iconUrl', event.target.value)}
                placeholder={t('prefs.customAgentIconUrlPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
              />
              <p className={styles.hint}>{t('prefs.customAgentIconUrlHint')}</p>
            </label>
          ) : null}
          {errorKey ? <p className={styles.error}>{t(errorKey)}</p> : null}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void onSave()}
              disabled={saving}
            >
              {t('prefs.customAgentSave')}
            </button>
            <button type="button" className={styles.ghost} onClick={closeForm}>
              {t('prefs.customAgentCancel')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.addButton} onClick={openAdd}>
          {t('prefs.customAgentAdd')}
        </button>
      )}
    </div>
  )
}

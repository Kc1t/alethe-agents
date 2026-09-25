import { Upload, X } from 'lucide-react'
import { useRef } from 'react'

import { useT } from '../../lib/i18n'
import controls from './controls.module.css'

const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export type ImageInputProps = {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  onEnter?: () => void
  previewColor?: string
  projectName?: string
}

export function ImageInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  onEnter,
  previewColor,
  projectName,
}: ImageInputProps) {
  const t = useT()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const pickImage = () => fileInputRef.current?.click()

  const onFileChange = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      window.alert(t('image.mustBeImage'))
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      window.alert(t('image.tooLarge'))
      return
    }

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    onChange(dataUrl)
  }

  const initial = (projectName || 'P').trim().charAt(0).toUpperCase()

  return (
    <div className={controls.field}>
      <label className={controls.label}>{label}</label>
      <div className={controls.inputActionRow} style={{ alignItems: 'center' }}>
        {}
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            overflow: 'hidden',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--border-strong)',
            background: previewColor || 'var(--panel)',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            color: '#fff',
            fontWeight: 700,
            fontSize: 18,
          }}
          title={value ? 'Preview da Foto/Ícone' : 'Foto Padrão'}
        >
          {value ? (
            <img
              src={value}
              alt="Icon Preview"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          ) : (
            <span>{initial}</span>
          )}
        </div>
        <input
          className={controls.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? t('image.placeholder')}
          onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
        />
        <button
          type="button"
          className={controls.iconBtn}
          onClick={pickImage}
          title={t('image.pickLocal')}
          aria-label={t('image.pickLocal')}
        >
          <Upload size={14} />
        </button>
        {value ? (
          <button
            type="button"
            className={controls.iconBtn}
            onClick={() => onChange('')}
            title={t('image.remove')}
            aria-label={t('image.remove')}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          void onFileChange(e.target.files?.[0])
          e.currentTarget.value = ''
        }}
      />
      {hint ? <span className={controls.hint}>{hint}</span> : null}
    </div>
  )
}

import { Pipette, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { useT } from '../../lib/i18n'
import controls from './controls.module.css'

export type ColorPalettePopoverProps = {
  open: boolean
  onClose: () => void
  onSelectColor: (color: string) => void
  selectedColor?: string
}

const PALETTE_GROUPS = [
  {
    nameKey: 'palette.vibrant' as const,
    colors: [
      '#6ea8ff',
      '#22d3ee',
      '#a78bfa',
      '#34d399',
      '#f59e0b',
      '#ef4444',
      '#ec4899',
      '#10b981',
      '#3b82f6',
      '#06b6d4',
      '#8b5cf6',
      '#f97316',
    ],
  },
  {
    nameKey: 'palette.neutral' as const,
    colors: ['#64748b', '#475569', '#334155', '#1e293b', '#0f172a', '#71717a', '#3f3f46'],
  },
  {
    nameKey: 'palette.pastel' as const,
    colors: [
      '#93c5fd',
      '#a5f3fc',
      '#c4b5fd',
      '#6ee7b7',
      '#fde047',
      '#fca5a5',
      '#f472b6',
      '#fed7aa',
    ],
  },
  {
    nameKey: 'palette.neon' as const,
    colors: ['#00ffcc', '#00ff66', '#ffff00', '#ff0077', '#a000ff', '#ff6600', '#00e5ff'],
  },
]

export function ColorPalettePopover({
  open,
  onClose,
  onSelectColor,
  selectedColor,
}: ColorPalettePopoverProps) {
  const t = useT()
  const colorInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  const normalizedSelected = selectedColor?.toLowerCase()

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 320,
          background: 'var(--surface-modal)',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          padding: 16,
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          position: 'relative',
          zIndex: 1101,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
            {t('crud.colorPaletteTitle')}
          </span>
          <button
            type="button"
            className={controls.iconBtn}
            onClick={onClose}
            aria-label={t('crud.cancel')}
          >
            <X size={14} />
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {PALETTE_GROUPS.map((group) => (
            <div key={group.nameKey} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--fg-faint)',
                  textTransform: 'uppercase',
                }}
              >
                {t(group.nameKey)}
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {group.colors.map((c) => {
                  const isSelected = normalizedSelected === c.toLowerCase()
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        onSelectColor(c)
                        onClose()
                      }}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: '50%',
                        background: c,
                        border: isSelected ? '2px solid var(--fg)' : '2px solid transparent',
                        boxShadow: isSelected ? '0 0 0 1px var(--bg)' : undefined,
                        cursor: 'pointer',
                        transition: 'transform 120ms ease',
                      }}
                      title={c}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{t('crud.customColor')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className={controls.btn}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                fontSize: 12,
              }}
              onClick={() => colorInputRef.current?.click()}
            >
              <Pipette size={14} />
              <span>{t('crud.pickColor')}</span>
            </button>
            <input
              ref={colorInputRef}
              type="color"
              value={selectedColor?.startsWith('#') ? selectedColor : '#64748b'}
              onChange={(e) => onSelectColor(e.target.value)}
              style={{
                position: 'absolute',
                opacity: 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

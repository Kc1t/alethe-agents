import { GROUP_COLORS } from '../../lib/types'
import controls from './controls.module.css'
import styles from './GroupFields.module.css'
import { ImageInput } from './ImageInput'

type GroupFieldsProps = {
  name: string
  color: string
  iconUrl: string
  onNameChange: (value: string) => void
  onColorChange: (value: string) => void
  onIconUrlChange: (value: string) => void
  onSubmit: () => void
  nameLabel: string
  namePlaceholder?: string
  colorLabel: string
  colorSwatchLabel: (color: string) => string
  iconLabel: string
  iconHint: string
  previewLabel?: string
  swatchSize?: number
}

export function GroupFields({
  name,
  color,
  iconUrl,
  onNameChange,
  onColorChange,
  onIconUrlChange,
  onSubmit,
  nameLabel,
  namePlaceholder,
  colorLabel,
  colorSwatchLabel,
  iconLabel,
  iconHint,
  previewLabel,
  swatchSize = 24,
}: GroupFieldsProps) {
  const previewIcon = iconUrl.trim()

  return (
    <>
      <div className={controls.field}>
        <label className={controls.label}>{nameLabel}</label>
        <input
          className={controls.input}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
          placeholder={namePlaceholder}
        />
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{colorLabel}</label>
        <div className={styles.swatches}>
          {GROUP_COLORS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => onColorChange(candidate)}
              aria-label={colorSwatchLabel(candidate)}
              className={`${styles.swatch} ${color === candidate ? styles.swatchSelected : ''}`}
              style={
                {
                  '--group-swatch-color': candidate,
                  '--group-swatch-size': `${swatchSize}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      </div>

      <ImageInput
        label={iconLabel}
        value={iconUrl}
        onChange={onIconUrlChange}
        onEnter={onSubmit}
        hint={iconHint}
      />

      {previewLabel ? (
        <div
          className={styles.preview}
          style={{ '--group-preview-color': color } as React.CSSProperties}
        >
          {previewIcon ? (
            <img src={previewIcon} alt="" className={styles.previewImage} />
          ) : (
            <span className={styles.previewDot} />
          )}
          {previewLabel}
        </div>
      ) : null}
    </>
  )
}

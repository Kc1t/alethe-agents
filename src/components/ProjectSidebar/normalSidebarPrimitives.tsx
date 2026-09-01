import styles from './NormalProjectSidebar.module.css'

                                                            
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/[\s\-_./\\]+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toLowerCase()
  return (parts[0][0] + parts[1][0]).toLowerCase()
}

                                                                                          
export function Monogram({
  name,
  iconUrl,
  color,
  size = 20,
}: {
  name: string
  iconUrl?: string
  color?: string
  size?: number
}) {
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        className={styles.projectIcon}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className={styles.monogram}
      style={{
        width: size,
        height: size,
        background: color || 'var(--panel-hover)',
        fontSize: Math.round(size * 0.46),
      }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  )
}

                                                     
export function GroupBadge({
  name,
  iconUrl,
  color,
}: {
  name: string
  iconUrl?: string
  color: string
}) {
  return <Monogram name={name} iconUrl={iconUrl} color={color} size={14} />
}

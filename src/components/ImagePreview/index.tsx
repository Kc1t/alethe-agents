import { convertFileSrc } from '@tauri-apps/api/core'

import styles from './ImagePreview.module.css'

export function ImagePreview({ path, className }: { path: string; className?: string }) {
  return (
    <img
      className={`${styles.image} ${className ?? ''}`}
      src={convertFileSrc(path)}
      alt=""
      draggable={false}
    />
  )
}

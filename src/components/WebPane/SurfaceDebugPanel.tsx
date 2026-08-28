import { formatSurfaceRect, type SurfaceDebugInfo } from './surfaceDebug'
import styles from './WebPane.module.css'

/**
 * Diagnostic overlay for native surface placement. Values only, no prose: it exists to be
 * screenshotted from the machine where the surface lands in the wrong place.
 */
export function SurfaceDebugPanel({ info }: { info: SurfaceDebugInfo }) {
  const flag = (on: boolean) => (on ? '✓' : '✗')
  return (
    <div className={styles.surfaceDebug} data-surface-debug>
      <div>css {formatSurfaceRect(info.css)}</div>
      <div>phys {formatSurfaceRect(info.physical)}</div>
      <div>dpr {info.ratio}</div>
      <div>
        visible {flag(info.visible)} · onscreen {flag(info.intersecting)} · clear{' '}
        {flag(!info.occluded)}
      </div>
      {info.failure ? <div className={styles.surfaceDebugFailure}>{info.failure}</div> : null}
    </div>
  )
}

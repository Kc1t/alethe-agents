import { Component, type ErrorInfo, type ReactNode } from 'react'

import { overlayContributions, useContributions } from '../../lib/plugins'
import { recordFrontendError } from '../../lib/tauri'

type BoundaryProps = { id: string; children: ReactNode }

// An overlay sits on top of the whole window, so a failing one must vanish instead of covering it.
class OverlayBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(`[Alethe][overlay:${this.props.id}]`, error)
    void recordFrontendError(
      error.message || String(error),
      error.stack ?? info.componentStack ?? null,
      `react:overlay:${this.props.id}`,
    )
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Mounts every overlay that an active plugin contributed. */
export function ContributedOverlays() {
  const overlays = useContributions(overlayContributions)
  return (
    <>
      {overlays.map(({ id, component: Overlay }) => (
        <OverlayBoundary key={id} id={id}>
          <Overlay />
        </OverlayBoundary>
      ))}
    </>
  )
}

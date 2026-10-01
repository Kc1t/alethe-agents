import { modalContributions, useContributions } from '../../lib/plugins'
import { useUiStore } from '../../stores/uiStore'

/** Mounts the plugin modal whose id matches the open one, if any. */
export function ContributedModals() {
  const modals = useContributions(modalContributions)
  const openModal = useUiStore((state) => state.openModal)
  const active = modals.find((modal) => modal.id === openModal)
  if (!active) return null
  const Component = active.component
  return <Component />
}

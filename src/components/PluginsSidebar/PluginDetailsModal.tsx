import { PluginDetails } from '../PluginDetailPane'
import { Modal } from '../modals/Modal'
import styles from './PluginDetailsModal.module.css'

export function PluginDetailsModal({
  pluginId,
  name,
  onClose,
  nested = false,
}: {
  pluginId: string
  name: string
  onClose: () => void
  nested?: boolean
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={name}
      width={680}
      nested={nested}
      className={styles.content}
    >
      <PluginDetails key={pluginId} pluginId={pluginId} onUninstalled={onClose} modal />
    </Modal>
  )
}

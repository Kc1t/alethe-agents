import { type MessageKey, useT } from '../../../lib/i18n'
import styles from './PluginsPage.module.css'

const CAPABILITY_KEYS: Record<string, MessageKey> = {
  'ui.theme': 'prefs.pluginsCapabilityTheme',
  'ui.pane': 'prefs.pluginsCapabilityPane',
  'ui.sidebarTab': 'prefs.pluginsCapabilitySidebarTab',
  'ui.command': 'prefs.pluginsCapabilityCommand',
  'ui.modal': 'prefs.pluginsCapabilityModal',
  'agent.provider': 'prefs.pluginsCapabilityAgentProvider',
  'invoke:git_*': 'prefs.pluginsCapabilityGit',
  'invoke:worktree_*': 'prefs.pluginsCapabilityWorktree',
}

export function CapabilityList({ capabilities }: { capabilities: readonly string[] }) {
  const t = useT()
  if (capabilities.length === 0) {
    return <p className={styles.emptyNote}>{t('prefs.pluginsCapabilitiesNone')}</p>
  }
  return (
    <ul className={styles.capabilityList}>
      {capabilities.map((capability) => {
        const key = CAPABILITY_KEYS[capability]
        return (
          <li key={capability}>
            {key ? t(key) : <code className={styles.capabilityRaw}>{capability}</code>}
          </li>
        )
      })}
    </ul>
  )
}

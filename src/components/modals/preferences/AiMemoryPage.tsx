import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { AiMemoryPanel } from './AiMemoryPanel'
import { SettingsSection } from './primitives'

export function AiMemoryPage() {
  const t = useT()
  const enabled = useProjectsStore((state) => state.preferences.enabledFeatures.aiMemory)
  const openModal = useUiStore((state) => state.openModal_)

  return (
    <SettingsSection
      id="ai-memory-service"
      title={t('prefs.aiMemoryServiceTitle')}
      description={t('prefs.aiMemoryServiceDesc')}
    >
      {!enabled ? (
        <p className={controls.hint}>
          {t('prefs.aiMemoryDisabled')}{' '}
          <button
            type="button"
            className={controls.btnLink}
            onClick={() =>
              openModal('preferences', { category: 'features', target: 'feature-aiMemory' })
            }
          >
            {t('prefs.aiMemoryEnableInFeatures')}
          </button>
        </p>
      ) : null}
      <AiMemoryPanel />
    </SettingsSection>
  )
}

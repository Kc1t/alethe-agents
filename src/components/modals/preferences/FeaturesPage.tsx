import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import { FeaturesStep } from '../onboarding/FeaturesStep'

export function FeaturesPage() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)

  return (
    <div id="optional-features">
      <FeaturesStep expandSecondaryByDefault showPlaywrightAdvanced />
      {preferences.enabledFeatures.mcp ? (
        <button
          type="button"
          className={controls.btnLink}
          onClick={() => useUiStore.getState().openModal_('mcpIntro')}
        >
          {t('mcp.runSetup')}
        </button>
      ) : null}
    </div>
  )
}

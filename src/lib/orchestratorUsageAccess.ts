import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { getLocale, translate } from './i18n'
import { USAGE_PROVIDERS } from './usageProviders'

/** The orchestrator warns and picks roles from the quota of these two. */
const ORCHESTRATOR_PROVIDERS = USAGE_PROVIDERS.filter(
  (provider) => provider.id === 'claude' || provider.id === 'codex',
)

/**
 * Turns the orchestrator feature on. It reads Claude and Codex quota, so their usage reading is
 * turned on with it and the user is told. This only happens on the switch from off to on: a user
 * who turns the reading off again afterwards keeps it off, and the orchestrator runs without quota.
 */
export function enableOrchestratorFeature(): void {
  const { preferences, setPreferences } = useProjectsStore.getState()
  if (preferences.enabledFeatures.orchestrator) return

  const turnedOn = ORCHESTRATOR_PROVIDERS.filter(
    (provider) => !preferences.usageAccess[provider.id],
  )
  const usageAccess = { ...preferences.usageAccess }
  for (const provider of turnedOn) usageAccess[provider.id] = true
  setPreferences({
    enabledFeatures: { ...preferences.enabledFeatures, orchestrator: true },
    ...(turnedOn.length > 0 ? { usageAccess } : {}),
  })
  if (turnedOn.length === 0) return

  const locale = getLocale()
  useUiStore.getState().pushToast({
    title: translate(locale, 'usageAccess.orchestratorToastTitle'),
    body: translate(locale, 'usageAccess.orchestratorToastBody', {
      providers: turnedOn.map((provider) => provider.label).join(', '),
    }),
  })
}

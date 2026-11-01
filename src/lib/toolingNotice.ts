import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { getLocale, translate } from './i18n'
import { countPending, inspectToolingManifest } from './toolingManifest'

export async function notifyMissingProfileTooling(): Promise<void> {
  const manifest = useProjectsStore.getState().preferences.toolingManifest
  if (!manifest || (manifest.mcpServers.length === 0 && manifest.skills.length === 0)) return
  const pending = await inspectToolingManifest(manifest, 'global', null).then(countPending, () => 0)
  if (pending === 0) return
  const locale = getLocale()
  const ui = useUiStore.getState()
  ui.pushToast({
    title: translate(locale, 'tooling.missingToastTitle'),
    body: translate(locale, 'tooling.missingToastBody', { count: pending }),
    actions: [
      {
        label: translate(locale, 'tooling.review'),
        run: () => useUiStore.getState().openModal_('profiles'),
      },
    ],
  })
}

import { useT } from '../../../../lib/i18n'
import type { VoiceCatalogModel } from '../../../../lib/tauri'
import type { CloudVoiceProviderId } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import controls from '../../controls.module.css'
import { ModelDropdown } from './ModelDropdown'
import { cloudStatus, PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { ProviderUseCard } from './ProviderUseCard'

/**
 * A cloud provider as a choice for one voice use. Without a key the card is locked: its models
 * stay listed (disabled) next to a "Set up key" link. The privacy note shows on the card in use.
 */
export function CloudUseCard({
  provider,
  models,
  selected,
  model,
  onPick,
  onOpenProvider,
  note,
}: {
  provider: CloudVoiceProviderId
  /** The provider's models for this use; must not be empty. */
  models: VoiceCatalogModel[]
  selected: boolean
  /** The model in use when `selected`. */
  model: string
  onPick: (model: string) => void
  onOpenProvider: (id: VoiceProviderId) => void
  /** Where the data goes, shown on the selected card. */
  note: string
}) {
  const t = useT()
  const flag = useProjectsStore((s) => s.preferences.voiceProviders[provider])
  const configured = flag?.configured === true
  const name = t(PROVIDER_META[provider].name)
  return (
    <ProviderUseCard
      icon={PROVIDER_META[provider].icon}
      title={name}
      description={t(PROVIDER_META[provider].description)}
      status={cloudStatus(flag)}
      selected={selected}
      disabled={!configured}
      onSelect={() => {
        if (!selected) onPick(models[0].id)
      }}
      note={selected ? note : undefined}
      footer={
        <>
          <ModelDropdown
            provider={name}
            models={models}
            value={selected ? model : models[0].id}
            locked={!configured}
            onChange={onPick}
          />
          {configured ? null : (
            <button
              type="button"
              className={controls.btn}
              aria-label={`${t('prefs.voiceActionSetUpKey')} ${name}`}
              onClick={() => onOpenProvider(provider)}
            >
              {t('prefs.voiceActionSetUpKey')}
            </button>
          )}
        </>
      }
    />
  )
}

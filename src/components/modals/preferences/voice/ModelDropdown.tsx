import { useT } from '../../../../lib/i18n'
import { Dropdown } from '../../../ui/Dropdown'

/** Lists longer than this get a search box. */
const SEARCH_THRESHOLD = 6

/**
 * Model picker in a usage card footer. A locked provider (no key yet) still shows its list, with
 * every entry disabled.
 */
export function ModelDropdown({
  provider,
  models,
  value,
  onChange,
  locked = false,
}: {
  provider: string
  models: { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
  locked?: boolean
}) {
  const t = useT()
  return (
    <Dropdown
      value={value}
      ariaLabel={t('prefs.voicePickModelFor', { provider })}
      searchable={models.length > SEARCH_THRESHOLD}
      placeholder={t('prefs.voicePickModel')}
      searchPlaceholder={t('prefs.voiceSearchModels')}
      options={models.map((model) => ({
        value: model.id,
        label: model.label,
        disabled: locked,
        searchText: `${model.label} ${model.id}`,
      }))}
      onChange={onChange}
    />
  )
}

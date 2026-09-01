import { useT } from '../../lib/i18n'
import { Dropdown } from '../ui/Dropdown'

export type ModelOption = {
  id: string
  label: string
}

export type ModelSearchablePickerProps = {
  value: string
  onChange: (modelId: string) => void
  options: ModelOption[]
  loading?: boolean
  providerName: string
}

export function ModelSearchablePicker({
  value,
  onChange,
  options,
  loading = false,
  providerName,
}: ModelSearchablePickerProps) {
  const t = useT()
  const cleanOptions = options.filter((option) => {
    const normalized = option.id.toLocaleLowerCase()
    return (
      option.id.length >= 3 &&
      !option.id.startsWith('-') &&
      !option.id.startsWith('#') &&
      !normalized.startsWith('could') &&
      !normalized.startsWith('usage') &&
      !normalized.startsWith('error') &&
      !normalized.startsWith('let')
    )
  })
  const fallbackLabel = cleanOptions[0]?.label ?? t('merge.modelSelect', { provider: providerName })

  return (
    <Dropdown
      value={value}
      onChange={onChange}
      options={cleanOptions.map((option) => ({
        value: option.id,
        label: option.label,
        searchText: `${option.label} ${option.id}`,
      }))}
      ariaLabel={t('merge.modelLabel', { provider: providerName })}
      placeholder={fallbackLabel}
      displayValue={loading ? t('merge.modelLoading') : undefined}
      disabled={loading}
      searchable
      searchPlaceholder={t('merge.modelSearch', {
        count: cleanOptions.length,
        provider: providerName,
      })}
      emptyLabel={(query) => t('merge.modelEmpty', { query })}
      allowCustomValue
      customOptionLabel={(model) => t('merge.modelCustom', { model })}
    />
  )
}

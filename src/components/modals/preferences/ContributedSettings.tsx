import { settingsContributions, useContributions } from '../../../lib/plugins'
import type { SettingsCategory } from '../../../lib/plugins/types'
import { ErrorBoundary } from '../../ErrorBoundary'
import { SettingsSection } from './primitives'

// Settings sections contributed by active plugins, in registration order.
export function ContributedSettings({
  category = 'integrations',
}: {
  category?: SettingsCategory
}) {
  const sections = useContributions(settingsContributions).filter(
    (section) => (section.category ?? 'integrations') === category,
  )
  return (
    <>
      {sections.map(({ id, title, description, component: Body }) => (
        <SettingsSection key={id} id={id} title={title()} description={description?.() ?? ''}>
          <ErrorBoundary label={`plugin-settings:${id}`}>
            <Body />
          </ErrorBoundary>
        </SettingsSection>
      ))}
    </>
  )
}

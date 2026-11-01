import { settingsContributions, useContributions } from '../../../lib/plugins'
import { ErrorBoundary } from '../../ErrorBoundary'
import { SettingsSection } from './primitives'

/** Settings sections contributed by active plugins, in registration order. */
export function ContributedSettings() {
  const sections = useContributions(settingsContributions)
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

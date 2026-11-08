import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: (
    selector: (state: { preferences: { enabledFeatures: { mcp: boolean } } }) => unknown,
  ) => selector({ preferences: { enabledFeatures: { mcp: false } } }),
}))
vi.mock('../../../stores/uiStore', () => ({
  useUiStore: { getState: () => ({ openModal_: vi.fn() }) },
}))
vi.mock('../onboarding/FeaturesStep', () => ({
  FeaturesStep: ({ onAiMemorySettings }: { onAiMemorySettings?: () => void }) => (
    <div>
      <div>Feature toggles</div>
      <button type="button" onClick={onAiMemorySettings}>
        Open AI Memory settings
      </button>
    </div>
  ),
}))

import { FeaturesPage } from './FeaturesPage'

describe('FeaturesPage AI Memory settings link', () => {
  it('does not render AI Memory service controls inline', () => {
    render(<FeaturesPage />)
    expect(screen.getByText('Feature toggles')).toBeTruthy()
    expect(screen.queryByText('AI Memory service controls')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open AI Memory settings' })).toBeTruthy()
  })
})

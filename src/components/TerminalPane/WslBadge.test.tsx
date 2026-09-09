import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const features = vi.hoisted(() => ({ wsl: true }))

vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: (
    selector: (state: {
      preferences: { language: string; enabledFeatures: { wsl: boolean } }
    }) => unknown,
  ) => selector({ preferences: { language: 'en', enabledFeatures: features } }),
}))

import { WslBadge } from './WslBadge'

afterEach(() => {
  cleanup()
  features.wsl = true
})

describe('WslBadge', () => {
  it('renders nothing for a Windows cwd', () => {
    const { container } = render(<WslBadge cwd={String.raw`C:\projects\x`} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for an empty cwd', () => {
    const { container } = render(<WslBadge cwd="" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders the distro name for a WSL UNC cwd', () => {
    render(<WslBadge cwd={String.raw`\\wsl.localhost\Ubuntu-22.04\home\dev\projects\app`} />)

    expect(screen.getByText('Ubuntu-22.04')).toBeInTheDocument()
  })

  it('renders nothing while the WSL integration is disabled', () => {
    features.wsl = false

    const { container } = render(
      <WslBadge cwd={String.raw`\\wsl.localhost\Ubuntu-22.04\home\dev`} />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('labels the badge as a WSL terminal', () => {
    render(<WslBadge cwd={String.raw`\\wsl.localhost\Ubuntu-22.04\home\dev`} />)

    expect(screen.getByLabelText('Running inside WSL · Ubuntu-22.04')).toBeInTheDocument()
  })
})

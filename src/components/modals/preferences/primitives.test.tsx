import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetCollapsedSectionsCache } from '../../../lib/settingsSections'
import { SettingsSection } from './primitives'

function renderSection(defaultCollapsed = false) {
  return render(
    <SettingsSection
      id="multiagent-metrics"
      title="Metrics"
      description="What the agents reported"
      defaultCollapsed={defaultCollapsed}
    >
      <p>the readings</p>
    </SettingsSection>,
  )
}

describe('a settings section folds away', () => {
  beforeEach(() => {
    localStorage.clear()
    resetCollapsedSectionsCache()
  })

  it('opens and closes from its own heading', () => {
    renderSection()
    const toggle = screen.getByRole('button', { name: /metrics/i })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('the readings')).toBeVisible()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('the readings')).not.toBeVisible()
  })

  it('keeps the description readable while folded, so you know what is inside', () => {
    renderSection(true)

    expect(screen.getByRole('button', { name: /metrics/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByText('What the agents reported')).toBeVisible()
  })

  it('remembers what was opened, over the section that ships folded', () => {
    const first = renderSection(true)
    fireEvent.click(screen.getByRole('button', { name: /metrics/i }))
    first.unmount()

    renderSection(true)

    expect(screen.getByRole('button', { name: /metrics/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('names the body it controls, so a screen reader follows the toggle', () => {
    renderSection()
    const toggle = screen.getByRole('button', { name: /metrics/i })
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '')

    expect(body).not.toBeNull()
    expect(body).toContainElement(screen.getByText('the readings'))
  })
})

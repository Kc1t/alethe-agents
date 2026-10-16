import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AiUsageModal } from './AiUsageModal'
import { UsageAccessStep } from './onboarding/UsageAccessStep'
import { TopbarSettingsModal } from './TopbarSettingsModal'

const PROVIDERS = ['Claude Code', 'Codex', 'Antigravity', 'Kimi Code', 'OpenRouter']

beforeEach(() => {
  useProjectsStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'en' } })
  useUiStore.setState({ openModal: null })
})

describe('OpenRouter sits with the other usage providers', () => {
  it('has its own usage reading switch, off at first, that turns on like the others', () => {
    render(<UsageAccessStep />)
    const rows = screen.getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual(
      PROVIDERS.map((name) => expect.stringContaining(name)),
    )
    const openrouter = rows[4]
    expect(openrouter).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(openrouter)
    expect(useProjectsStore.getState().preferences.usageAccess.openrouter).toBe(true)
  })

  it('has a topbar switch like the other providers', () => {
    useUiStore.setState({ openModal: 'topbarSettings' })
    render(<TopbarSettingsModal />)
    expect(screen.getByText('OpenRouter balance')).toBeInTheDocument()
    expect(screen.getByText('Antigravity status')).toBeInTheDocument()
  })

  it('has panel and topbar switches in the usage modal editor', () => {
    useUiStore.setState({ openModal: 'aiUsage' })
    render(<AiUsageModal />)
    fireEvent.click(screen.getByRole('button', { name: /customize/i }))
    for (const name of PROVIDERS) {
      const row = screen.getByText(name).closest('div')!
      expect(within(row).getAllByRole('switch')).toHaveLength(2)
    }
    const openrouterRow = screen.getByText('OpenRouter').closest('div')!
    const [panel, topbar] = within(openrouterRow).getAllByRole('switch')
    fireEvent.click(topbar)
    expect(useProjectsStore.getState().preferences.topbarShowOpenRouterUsage).toBe(false)
    fireEvent.click(panel)
    expect(useProjectsStore.getState().preferences.usageShowOpenRouter).toBe(false)
  })
})

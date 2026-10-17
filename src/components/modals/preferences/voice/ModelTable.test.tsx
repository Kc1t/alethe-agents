import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelTable } from './ModelTable'
import { TierDots } from './TierDots'

vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

afterEach(cleanup)

describe('ModelTable', () => {
  const sections = [
    {
      id: 'stt',
      title: 'Speech to text',
      hint: 'Dictation and Conversation',
      rows: [{ id: 'a', name: 'Alpha', cells: { size: '10 MB' }, details: <p>alpha details</p> }],
    },
  ]

  it('expands a row to show its details', () => {
    render(<ModelTable sections={sections} columns={['size']} />)
    const toggle = screen.getByRole('button', { name: /Alpha/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // A collapsed row has no panel in the DOM, so it must not point at one.
    expect(toggle.hasAttribute('aria-controls')).toBe(false)
    expect(screen.queryByText('alpha details')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('alpha details')).toBeTruthy()
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(panel?.tagName).toBe('TR')
    expect(panel?.textContent).toContain('alpha details')
    expect(panel?.querySelector('td')?.getAttribute('colspan')).toBe('3')
  })

  it('renders section titles as row groups', () => {
    render(<ModelTable sections={sections} columns={['size']} />)
    expect(screen.getByText('Speech to text')).toBeTruthy()
    expect(screen.getByText('Dictation and Conversation')).toBeTruthy()
    const group = screen.getByRole('rowgroup', { name: 'Speech to text' })
    expect(within(group).getByText('10 MB')).toBeTruthy()
  })

  it('labels the header columns and marks a recommended row', () => {
    render(
      <ModelTable
        sections={[{ ...sections[0], rows: [{ ...sections[0].rows[0], recommended: true }] }]}
        columns={['languages', 'size', 'status']}
      />,
    )
    expect(screen.getByRole('columnheader', { name: 'prefs.voiceColModel' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'prefs.voiceColLanguages' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'prefs.voiceColStatus' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'prefs.voiceColActions' })).toBeTruthy()
    expect(screen.getByRole('table')).toBeTruthy()
    const row = screen.getByRole('button', { name: /Alpha/ }).closest('tr') as HTMLElement
    expect(row.getAttribute('role')).toBe('row')
    expect(within(row).getAllByRole('cell')).toHaveLength(5)
    expect(screen.getByText('prefs.voiceRecommended')).toBeTruthy()
  })

  it('relabels a column for a section that sets its own label', () => {
    const tts = {
      id: 'tts',
      title: 'Text to speech',
      hint: 'Narration',
      columnLabels: { accuracy: 'Quality' },
      rows: [{ id: 'b', name: 'Beta', cells: {}, details: null }],
    }
    const { unmount } = render(<ModelTable sections={[tts]} columns={['accuracy']} />)
    // Every listed section agrees, so the header takes the section's label.
    expect(screen.getByRole('columnheader', { name: 'Quality' })).toBeTruthy()
    unmount()
    render(<ModelTable sections={[sections[0], tts]} columns={['accuracy']} />)
    expect(screen.getByRole('columnheader', { name: 'prefs.voiceColAccuracy' })).toBeTruthy()
    const beta = screen.getByRole('button', { name: /Beta/ }).closest('tr') as HTMLElement
    expect(beta.querySelector('[data-column="accuracy"]')?.getAttribute('data-label')).toBe(
      'Quality',
    )
    const alpha = screen.getByRole('button', { name: /Alpha/ }).closest('tr') as HTMLElement
    expect(alpha.querySelector('[data-column="accuracy"]')?.getAttribute('data-label')).toBe(
      'prefs.voiceColAccuracy',
    )
  })

  it('reports filter and search changes', () => {
    const onFilter = vi.fn()
    const onSearch = vi.fn()
    render(
      <ModelTable
        sections={sections}
        columns={['size']}
        filter={{
          label: 'Filter by use',
          value: 'all',
          options: [
            { value: 'all', label: 'All' },
            { value: 'tts', label: 'TTS' },
          ],
          onChange: onFilter,
        }}
        search={{ value: '', onChange: onSearch, placeholder: 'Search' }}
      />,
    )
    expect(screen.getByRole('group', { name: 'Filter by use' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'TTS' }))
    expect(onFilter).toHaveBeenCalledWith('tts')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'whi' },
    })
    expect(onSearch).toHaveBeenCalledWith('whi')
  })
})

describe('ModelTable empty state', () => {
  it('shows the empty message in a full-width row', () => {
    render(<ModelTable sections={[]} columns={['size']} empty="Loading models" />)
    const cell = screen.getByRole('cell', { name: 'Loading models' })
    expect(cell.getAttribute('colspan')).toBe('3')
  })
})

describe('TierDots', () => {
  it('labels the tier out of three', () => {
    render(<TierDots tier={2} label="Speed" />)
    const dots = screen.getByLabelText('prefs.voiceTierLabel:{"label":"Speed","tier":2}')
    expect(dots.getAttribute('title')).toBe('prefs.voiceTierSource')
    expect(dots.querySelectorAll('[data-filled="true"]')).toHaveLength(2)
    expect(dots.querySelectorAll('[data-filled="false"]')).toHaveLength(1)
  })

  it('renders a dash without a tier', () => {
    const { container } = render(<TierDots label="Speed" />)
    expect(container.textContent).toBe('—')
  })
})

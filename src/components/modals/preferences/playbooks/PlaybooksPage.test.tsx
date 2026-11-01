import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { orchestratorPlaybooks, orchestratorSavePlaybooks } from '../../../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { PlaybooksPage } from './PlaybooksPage'

vi.mock('../../../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../../../lib/tauri')>()),
  orchestratorPlaybooks: vi.fn(),
  orchestratorSavePlaybooks: vi.fn(),
  getClaudeUsage: vi.fn(async () => {
    throw new Error('off')
  }),
}))

const BUNDLED = readFileSync(
  resolve(__dirname, '../../../../../src-tauri/assets/skills/alethe/playbooks.yaml'),
  'utf8',
)
const PATH = 'C:/Users/me/AppData/Roaming/Alethe/alethe-playbooks.yaml'

beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  vi.mocked(orchestratorPlaybooks).mockResolvedValue({ text: BUNDLED, path: PATH, custom: false })
  vi.mocked(orchestratorSavePlaybooks).mockImplementation(async (text) => ({
    text,
    path: PATH,
    custom: true,
  }))
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  })
  Element.prototype.setPointerCapture = vi.fn()
})

afterEach(() => vi.restoreAllMocks())

describe('PlaybooksPage', { timeout: 20_000 }, () => {
  it('draws the first playbook and lists every playbook, preset and provider', async () => {
    render(<PlaybooksPage />)

    expect(
      await screen.findByRole('application', { name: 'Flow of the selected playbook' }),
    ).toBeTruthy()
    expect(screen.getAllByText('Complete').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Review gate/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Balanced/ })).toBeTruthy()
    expect(screen.getByText('Narrow task?')).toBeTruthy()
    expect(
      screen.getByText('The skill plans with its bundled playbooks. Saving writes your own copy.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('edits a phase from the flow and saves the playbooks file', async () => {
    const { container } = render(<PlaybooksPage />)
    await screen.findByText('Narrow task?')

    const build = container.querySelector('[data-node="phase:build"]') as Element
    fireEvent.pointerDown(build, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(build, { clientX: 10, clientY: 10, pointerId: 1 })

    const role = await screen.findByRole('textbox', { name: 'Role' })
    fireEvent.change(role, { target: { value: 'implementer' } })
    fireEvent.blur(role)

    expect(screen.getByTitle('Unsaved changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(orchestratorSavePlaybooks).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(orchestratorSavePlaybooks).mock.calls[0][0]
    expect(saved).toContain('role: implementer')
    expect(saved).toContain('basedOn: balanced')
    await waitFor(() => expect(screen.getByText('The skill plans with your copy.')).toBeTruthy())
  })

  it('adds a block, refuses to save while it is loose, and deletes it', async () => {
    render(<PlaybooksPage />)
    await screen.findByText('Narrow task?')

    fireEvent.click(screen.getByRole('button', { name: 'Model price' }))
    expect((await screen.findAllByText('model over $5/1M input')).length).toBeGreaterThan(0)
    expect(screen.getByText('Problems to fix before saving: 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(
      screen.getAllByText('Not connected to the flow, so it is left out.').length,
    ).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Delete decision' }))
    expect(screen.queryByText('model over $5/1M input')).toBeNull()
    expect(screen.queryByText('Problems to fix before saving: 1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

  it('starts a new playbook from a lead step to the result', async () => {
    render(<PlaybooksPage />)
    await screen.findByText('Narrow task?')

    fireEvent.click(screen.getByRole('button', { name: 'New playbook' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(orchestratorSavePlaybooks).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(orchestratorSavePlaybooks).mock.calls[0][0]
    expect(saved).toContain(
      '  custom-1:\n    name: "New playbook"\n    phases:\n      - { id: plan, role: planner, who: lead, tier: strong, then: done }',
    )
  })

  it('changes a rule for every role on the active profile only', async () => {
    render(<PlaybooksPage />)
    await screen.findByText('Narrow task?')

    fireEvent.click(screen.getByRole('button', { name: /savings/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit rules for every role' }))
    const threshold = screen.getByRole('spinbutton', { name: 'Tokens low at %' })
    fireEvent.change(threshold, { target: { value: '60' } })
    fireEvent.blur(threshold)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(orchestratorSavePlaybooks).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(orchestratorSavePlaybooks).mock.calls[0][0]
    expect(saved).toContain('profile: savings')
    expect(saved).toContain('quota: { criticalThreshold: 60, stopAt: 90 }')
    expect(saved).toMatch(/quota:\n {2}criticalThreshold: 80/)
  })

  it('says why the file could not be read', async () => {
    vi.mocked(orchestratorPlaybooks).mockResolvedValue({ text: 'a: [', path: PATH, custom: true })
    render(<PlaybooksPage />)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not read the playbooks: line 1:',
    )
  })
})

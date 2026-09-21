import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ProjectGrids } from '../ProjectSidebar/ProjectGrids'
import { ProjectGridModal } from './ProjectGridModal'

vi.mock('../../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useUiStore.getState().closeModal()
})
afterEach(cleanup)

function setup() {
  const store = useProjectsStore.getState()
  const project = store.createProject({ name: 'App' })
  const gridId = store.createProjectGrid(project.id, 'Backend')!
  const terminal = store.createTerminal(project.id, {
    name: 'Shell',
    cwd: 'C:\\repo',
    firstTab: { type: 'shell', cwd: 'C:\\repo' },
  })
  return { projectId: project.id, gridId, terminalId: terminal.id }
}

describe('project grid controls', () => {
  it('creates a grid by name and reports duplicate names in the modal', () => {
    const { projectId } = setup()
    useUiStore.getState().openModal_('projectGrid', { projectId, action: 'create' })
    render(<ProjectGridModal />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Backend' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent('unique')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Frontend' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useProjectsStore.getState().projects[0].grids?.map((grid) => grid.name)).toEqual([
      'Backend',
      'Frontend',
    ])
  })

  it.each(['keep', 'delete'] as const)(
    'offers both deletion choices and handles %s',
    async (choice) => {
      const { projectId, gridId } = setup()
      useUiStore.getState().openModal_('projectGrid', { projectId, gridId, action: 'delete' })
      render(<ProjectGridModal />)
      expect(screen.getByText(/1 terminal\(s\)/)).toBeInTheDocument()
      const keep = screen.getByRole('button', { name: 'Move to Default and remove grid' })
      const remove = screen.getByRole('button', { name: 'Delete grid and terminals' })
      fireEvent.click(choice === 'keep' ? keep : remove)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(useProjectsStore.getState().projects[0].grids).toHaveLength(0)
      expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(
        choice === 'keep' ? 1 : 0,
      )
      if (choice === 'keep')
        expect(useProjectsStore.getState().projects[0].terminals[0].gridId).toBeUndefined()
    },
  )

  it('cancels deletion without changing the project', () => {
    const { projectId, gridId } = setup()
    useUiStore.getState().openModal_('projectGrid', { projectId, gridId, action: 'delete' })
    render(<ProjectGridModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useProjectsStore.getState().projects[0].grids).toHaveLength(1)
    expect(useProjectsStore.getState().projects[0].terminals).toHaveLength(1)
  })

  it('moves a terminal out of its grid and back to ungrouped', () => {
    const { projectId, terminalId } = setup()
    useUiStore.getState().openModal_('projectGrid', { projectId, terminalId, action: 'move' })
    render(<ProjectGridModal />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'default' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useProjectsStore.getState().projects[0].terminals[0].gridId).toBeUndefined()
  })

  it('renders the shared sidebar tree and opens grids without exposing other grids in the workspace', () => {
    const { projectId, gridId } = setup()
    function Tree() {
      const project = useProjectsStore((state) => state.projects[0])
      return (
        <ProjectGrids project={project} isActive>
          {(terminal) => <span key={terminal.id}>{terminal.name}</span>}
        </ProjectGrids>
      )
    }
    render(<Tree />)
    expect(screen.queryByRole('button', { name: /Default/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Backend 1' }))
    expect(useProjectsStore.getState().workspace.containers[0].gridId).toBe(gridId)
    act(() => useUiStore.getState().openModal_('projectGrid', { projectId, action: 'create' }))
    expect(screen.getByText('Shell')).toBeInTheDocument()
  })
})

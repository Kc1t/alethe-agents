import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Modal } from '../modals/Modal'
import { Dropdown } from './Dropdown'

afterEach(cleanup)

describe('Dropdown', () => {
  it('selects a portal option without dismissing its parent modal', () => {
    const onChange = vi.fn()
    const onClose = vi.fn()

    render(
      <Modal open onClose={onClose} title="Settings">
        <Dropdown
          value="first"
          onChange={onChange}
          ariaLabel="Choice"
          options={[
            { value: 'first', label: 'First' },
            { value: 'second', label: 'Second' },
          ]}
        />
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choice' }))
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Second' }))
    fireEvent.click(screen.getByRole('option', { name: 'Second' }))

    expect(onChange).toHaveBeenCalledWith('second')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('marks the selected option without changing its accessible name', () => {
    render(
      <Dropdown
        value="second"
        onChange={vi.fn()}
        ariaLabel="Choice"
        options={[
          { value: 'first', label: 'First' },
          { value: 'second', label: 'Second' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choice' }))

    const selected = screen.getByRole('option', { name: 'Second' })
    expect(selected).toHaveAttribute('aria-selected', 'true')
    expect(selected.querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('option', { name: 'First' }).querySelector('svg')).toBeNull()
  })

  it('renders the placeholder as a placeholder when nothing is selected', () => {
    render(
      <Dropdown
        value=""
        placeholder="Select a project"
        onChange={vi.fn()}
        ariaLabel="Project"
        options={[{ value: 'alpha', label: 'Alpha' }]}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Project' })
    expect(trigger).toHaveTextContent('Select a project')
    expect(trigger).toHaveAttribute('data-placeholder')
  })

  it('closes the dropdown before its parent modal on Escape', () => {
    const onClose = vi.fn()

    render(
      <Modal open onClose={onClose} title="Settings">
        <Dropdown
          value="first"
          onChange={vi.fn()}
          ariaLabel="Choice"
          options={[{ value: 'first', label: 'First' }]}
        />
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choice' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('filters searchable options and accepts a custom value', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value=""
        onChange={onChange}
        ariaLabel="Model"
        placeholder="Select model"
        searchable
        searchPlaceholder="Search models"
        emptyLabel={(query) => `No result for ${query}`}
        allowCustomValue
        customOptionLabel={(value) => `Use ${value}`}
        options={[
          { value: 'alpha', label: 'Alpha', searchText: 'Alpha alpha' },
          { value: 'beta', label: 'Beta', searchText: 'Beta beta' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), {
      target: { value: 'custom-model' },
    })
    fireEvent.click(screen.getByRole('option', { name: 'Use custom-model' }))

    expect(onChange).toHaveBeenCalledWith('custom-model')
  })

  it('selects the first enabled search result with Enter', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value=""
        onChange={onChange}
        ariaLabel="Project"
        searchable
        searchPlaceholder="Search projects"
        options={[
          { value: 'blocked', label: 'Blocked', disabled: true },
          { value: 'ready', label: 'Ready' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search projects' }), {
      key: 'Enter',
    })

    expect(onChange).toHaveBeenCalledWith('ready')
  })

  it('navigates options with the keyboard and skips disabled entries', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value="first"
        onChange={onChange}
        ariaLabel="Choice"
        options={[
          { value: 'first', label: 'First' },
          { value: 'blocked', label: 'Blocked', disabled: true },
          { value: 'third', label: 'Third' },
        ]}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Choice' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('third')
  })

  it('uses the active searchable result instead of always selecting the first one', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value="alpha"
        onChange={onChange}
        ariaLabel="Model"
        searchable
        searchPlaceholder="Search models"
        options={[
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const search = screen.getByRole('textbox', { name: 'Search models' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('beta')
  })
})

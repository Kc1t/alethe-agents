import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('walks the options with the arrow keys and chooses with Enter', () => {
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
    // Opens on the current value, then steps over the option that cannot be chosen.
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'First' }).id,
    )
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Third' }).id,
    )
    // Past the end it comes back around to the start.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'First' }).id,
    )
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('third')
    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeInTheDocument()
  })

  it('reports no change when the current value is chosen again', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value="first"
        onChange={onChange}
        ariaLabel="Choice"
        options={[
          { value: 'first', label: 'First' },
          { value: 'second', label: 'Second' },
        ]}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Choice' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeInTheDocument()
  })

  it('moves through search results with the arrow keys', () => {
    const onChange = vi.fn()

    render(
      <Dropdown
        value=""
        onChange={onChange}
        ariaLabel="Model"
        searchable
        searchPlaceholder="Search models"
        options={[
          { value: 'alpha', label: 'Alpha' },
          { value: 'alpine', label: 'Alpine' },
          { value: 'beta', label: 'Beta' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const search = screen.getByRole('textbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'al' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('alpine')
  })

  it('lets its search field take focus inside a modal that traps focus', async () => {
    render(
      <Modal open onClose={vi.fn()} title="Settings">
        <Dropdown
          value=""
          onChange={vi.fn()}
          ariaLabel="Model"
          searchable
          searchPlaceholder="Search models"
          options={[{ value: 'alpha', label: 'Alpha' }]}
        />
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const search = screen.getByRole('textbox', { name: 'Search models' })

    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('keeps the wheel over its list away from a scroll lock on the document', () => {
    const onDocumentWheel = vi.fn()
    document.addEventListener('wheel', onDocumentWheel)

    render(
      <Dropdown
        value="first"
        onChange={vi.fn()}
        ariaLabel="Choice"
        options={[
          { value: 'first', label: 'First' },
          { value: 'second', label: 'Second' },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choice' }))
    fireEvent.wheel(screen.getByRole('option', { name: 'Second' }), { deltaY: 120 })
    document.removeEventListener('wheel', onDocumentWheel)

    expect(onDocumentWheel).not.toHaveBeenCalled()
  })
})

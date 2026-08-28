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
})

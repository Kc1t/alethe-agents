import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Modal } from '../modals/Modal'
import { Dropdown } from './Dropdown'

afterEach(cleanup)

describe('Dropdown', () => {
  it('mounts its menu inside the modal, so the search field can hold focus', () => {
    // The bug this exists for: a menu portalled to `document.body` sits outside the Radix dialog's
    // focus scope, and the dialog pulls focus straight back out of anything focused there. The
    // options kept working because they act on pointer-down; the search field looked dead, because
    // a click focused it and lost it again in the same tick.
    render(
      <Modal open onClose={() => {}} title="Settings">
        <Dropdown
          value="first"
          onChange={() => {}}
          ariaLabel="Choice"
          searchable
          searchPlaceholder="Search models"
          options={[
            { value: 'first', label: 'First' },
            { value: 'second', label: 'Second' },
          ]}
        />
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choice' }))
    const search = screen.getByPlaceholderText('Search models')
    const dialog = document.querySelector('[data-alethe-modal-content]')

    expect(dialog).not.toBeNull()
    expect(dialog?.contains(search)).toBe(true)

    // And it accepts typing, which is the whole point of being able to click it.
    fireEvent.change(search, { target: { value: 'sec' } })
    expect(screen.queryByRole('option', { name: /First/ })).toBeNull()
    expect(screen.getByRole('option', { name: /Second/ })).toBeTruthy()
  })

  it('still mounts on the body when there is no modal around it', () => {
    render(
      <Dropdown
        value="first"
        onChange={() => {}}
        ariaLabel="Loose"
        options={[{ value: 'first', label: 'First' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Loose' }))
    const menu = document.querySelector('[data-alethe-dropdown-menu]')
    expect(menu?.parentElement).toBe(document.body)
  })

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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTodosStore } from './store'
import { TodoSidebar } from './TodoSidebar'
import styles from './TodoSidebar.module.css'

const css = readFileSync(resolve('src/plugins/todos/TodoSidebar.module.css'), 'utf8')
const originalProjects = useProjectsStore.getState()
const originalTodos = useTodosStore.getState()
let stylesheet: HTMLStyleElement

beforeEach(() => {
  useProjectsStore.setState(structuredClone(EMPTY_PROJECTS_FILE))
  useTodosStore.setState({ todos: [] })
  stylesheet = document.createElement('style')
  stylesheet.textContent = ['todoTitle', 'titleButton', 'todoTitleText']
    .map((name) => {
      const rule = css.match(new RegExp(`\\.${name}\\s*\\{([^}]+)\\}`))?.[1]
      return `.${styles[name]} { ${rule} }`
    })
    .join('\n')
  document.head.appendChild(stylesheet)
})

afterEach(() => {
  cleanup()
  stylesheet.remove()
  useProjectsStore.setState(originalProjects)
  useTodosStore.setState(originalTodos)
})

describe('TodoSidebar task titles', () => {
  it('reserves a full wrapping line for the task title alongside its metadata', () => {
    const title = 'Review the release checklist and SupercalifragilisticexpialidociousWithoutSpaces'
    useTodosStore.getState().createTodo(title, ['release', 'review'])

    render(<TodoSidebar />)

    const titleElement = screen.getByText(title)
    const titleButton = screen.getByRole('button', { name: title })
    expect(getComputedStyle(titleButton.parentElement!).flexWrap).toBe('wrap')
    expect(getComputedStyle(titleButton).flexBasis).toBe('100%')
    const titleStyle = getComputedStyle(titleElement)
    expect(titleStyle.whiteSpace).toBe('normal')
    expect(titleStyle.overflowWrap).toBe('anywhere')
    expect(titleStyle.textOverflow).not.toBe('ellipsis')
  })
})

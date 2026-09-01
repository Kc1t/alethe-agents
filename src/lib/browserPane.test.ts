import { describe, expect, it } from 'vitest'

import { normalizeBrowserUrl } from './browserUrl'
import { makeWebPane } from './terminalFactory'

describe('makeWebPane', () => {
  it('creates a private-browser pane with safe defaults', () => {
    const pane = makeWebPane({ url: 'https://example.com/' })

    expect(pane.kind).toBe('web')
    expect(pane.name).toBe('example.com')
    expect(pane.browserConfig).toEqual({
      javascriptEnabled: true,
      resourceMode: 'app-first',
      zoom: 1,
    })
  })

  it('persists the browser settings selected in the modal', () => {
    const pane = makeWebPane({
      url: 'http://localhost:5173/',
      name: 'Local app',
      javascriptEnabled: false,
      resourceMode: 'balanced',
      zoom: 1.25,
    })

    expect(pane.name).toBe('Local app')
    expect(pane.browserConfig).toEqual({
      javascriptEnabled: false,
      resourceMode: 'balanced',
      zoom: 1.25,
    })
  })
})

describe('normalizeBrowserUrl for address bar', () => {
  it('accepts bare hosts as https', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/')
  })
})

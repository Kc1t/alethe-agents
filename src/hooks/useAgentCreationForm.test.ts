import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useAgentCreationForm } from './useAgentCreationForm'

describe('useAgentCreationForm', () => {
  it('resets all shared creation fields to the requested defaults', () => {
    const { result } = renderHook(() => useAgentCreationForm('shell'))

    act(() => {
      result.current.setType('codex')
      result.current.setRuntimeProfile('diagnostic')
      result.current.toggleUnrestricted('codex')
    })
    expect(result.current.type).toBe('codex')
    expect(result.current.runtimeProfile).toBe('diagnostic')
    expect(result.current.unrestricted.codex).toBe(true)

    act(() => result.current.resetAgentCreation('claude', true))
    expect(result.current.type).toBe('claude')
    expect(result.current.runtimeProfile).toBe('lean')
    expect(Object.values(result.current.unrestricted).every(Boolean)).toBe(true)
  })
})

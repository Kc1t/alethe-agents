import { beforeEach, describe, expect, it } from 'vitest'

import {
  getStorageNamespace,
  readScopedStorage,
  removeScopedStorage,
  scopedStorageKey,
  setStorageNamespace,
  writeScopedStorage,
} from './storageNamespace'

beforeEach(() => {
  localStorage.clear()
  setStorageNamespace('default')
})

describe('scopedStorageKey', () => {
  it('namespaces the key under the active profile', () => {
    setStorageNamespace('work')
    expect(scopedStorageKey('active-sessions')).toBe('alethe:work:active-sessions')
  })

  it('falls back to "default" for a blank namespace', () => {
    setStorageNamespace('   ')
    expect(getStorageNamespace()).toBe('default')
  })
})

describe('writeScopedStorage / readScopedStorage / removeScopedStorage', () => {
  it('round-trips a value under the active namespace', () => {
    writeScopedStorage('active-sessions', '{"a":1}')
    expect(readScopedStorage('active-sessions')).toBe('{"a":1}')
    removeScopedStorage('active-sessions')
    expect(readScopedStorage('active-sessions')).toBeNull()
  })

  it('does not see a value written under a different profile', () => {
    setStorageNamespace('work')
    writeScopedStorage('active-sessions', '{"work":true}')
    setStorageNamespace('personal')
    expect(readScopedStorage('active-sessions')).toBeNull()
  })
})

// A migração de chave legada (versões antigas do app, sem namespace de perfil)
// só pode valer para o perfil "default" — senão a sessão de um perfil não-default
// vazaria os dados legados globais na primeira leitura.
describe('legacy key migration', () => {
  it('migrates an alethe: legacy key into the default namespace on first read', () => {
    localStorage.setItem('alethe:active-sessions', '{"legacy":true}')
    expect(readScopedStorage('active-sessions', true)).toBe('{"legacy":true}')
    expect(localStorage.getItem('alethe:default:active-sessions')).toBe('{"legacy":true}')
  })

  it('migrates an ancient ensemble: legacy key into the default namespace', () => {
    localStorage.setItem('ensemble:active-sessions', '{"ancient":true}')
    expect(readScopedStorage('active-sessions', true)).toBe('{"ancient":true}')
    expect(localStorage.getItem('alethe:default:active-sessions')).toBe('{"ancient":true}')
  })

  it('prefers an already-namespaced value over any legacy key', () => {
    localStorage.setItem('alethe:active-sessions', '{"legacy":true}')
    writeScopedStorage('active-sessions', '{"current":true}')
    expect(readScopedStorage('active-sessions', true)).toBe('{"current":true}')
  })

  it('never falls back to legacy keys when allowLegacy is false', () => {
    localStorage.setItem('alethe:active-sessions', '{"legacy":true}')
    expect(readScopedStorage('active-sessions', false)).toBeNull()
  })

  it('never leaks legacy/global session data into a non-default profile', () => {
    localStorage.setItem('alethe:active-sessions', '{"legacy":true}')
    setStorageNamespace('work')
    expect(readScopedStorage('active-sessions', true)).toBeNull()
    expect(localStorage.getItem('alethe:work:active-sessions')).toBeNull()
  })
})

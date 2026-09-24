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
  it('usa o namespace ativo', () => {
    expect(scopedStorageKey('foo')).toBe('alethe:default:foo')
    setStorageNamespace('work')
    expect(scopedStorageKey('foo')).toBe('alethe:work:foo')
    expect(getStorageNamespace()).toBe('work')
  })

  it('usa default para namespace em branco', () => {
    setStorageNamespace('   ')
    expect(scopedStorageKey('foo')).toBe('alethe:default:foo')
  })
})

describe('readScopedStorage', () => {
  it('retorna o valor do namespace quando existe', () => {
    localStorage.setItem('alethe:default:foo', 'current')
    expect(readScopedStorage('foo')).toBe('current')
  })

  it('lê e copia o formato legacy alethe quando permitido', () => {
    localStorage.setItem('alethe:foo', 'legacy')
    expect(readScopedStorage('foo', true)).toBe('legacy')
    expect(localStorage.getItem('alethe:default:foo')).toBe('legacy')
  })

  it('lê e copia o formato antigo ensemble quando permitido', () => {
    localStorage.setItem('ensemble:foo', 'ancient')
    expect(readScopedStorage('foo', true)).toBe('ancient')
    expect(localStorage.getItem('alethe:default:foo')).toBe('ancient')
  })

  it('ignora chaves legacy quando allowLegacy é falso', () => {
    localStorage.setItem('alethe:foo', 'legacy')
    expect(readScopedStorage('foo')).toBeNull()
    expect(localStorage.getItem('alethe:default:foo')).toBeNull()
  })

  it('não herda dados legacy fora do namespace default', () => {
    localStorage.setItem('alethe:foo', 'legacy')
    setStorageNamespace('work')
    expect(readScopedStorage('foo', true)).toBeNull()
  })

  it('retorna null quando nenhuma chave existe', () => {
    expect(readScopedStorage('missing', true)).toBeNull()
  })
})

describe('writeScopedStorage and removeScopedStorage', () => {
  it('grava e remove no namespace ativo', () => {
    writeScopedStorage('foo', 'value')
    expect(localStorage.getItem('alethe:default:foo')).toBe('value')
    removeScopedStorage('foo')
    expect(localStorage.getItem('alethe:default:foo')).toBeNull()
  })
})

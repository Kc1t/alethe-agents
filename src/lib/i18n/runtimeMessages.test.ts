import { describe, expect, it } from 'vitest'

import { registerMessages, translate, translateDynamic } from './index'

describe('runtime messages', () => {
  it('resolves a registered key and stops resolving after the undo', () => {
    const key = 'plugin.test.title'
    expect(translateDynamic('en', key)).toBe(key)

    const undo = registerMessages('en', { [key]: 'Hello' })
    expect(translateDynamic('en', key)).toBe('Hello')

    undo()
    expect(translateDynamic('en', key)).toBe(key)
  })

  it('interpolates parameters like core messages do', () => {
    const undo = registerMessages('en', { 'plugin.test.greet': 'Hi {name}' })
    expect(translateDynamic('en', 'plugin.test.greet', { name: 'Kauã' })).toBe('Hi Kauã')
    undo()
  })

  it('falls back to the English runtime message for an untranslated locale', () => {
    const undo = registerMessages('en', { 'plugin.test.only-en': 'English only' })
    expect(translateDynamic('pt-BR', 'plugin.test.only-en')).toBe('English only')
    undo()
  })

  it('prefers the locale message when both are registered', () => {
    const undoEn = registerMessages('en', { 'plugin.test.both': 'English' })
    const undoPt = registerMessages('pt-BR', { 'plugin.test.both': 'Português' })
    expect(translateDynamic('pt-BR', 'plugin.test.both')).toBe('Português')
    expect(translateDynamic('en', 'plugin.test.both')).toBe('English')
    undoPt()
    undoEn()
  })

  it('never lets a runtime message shadow a core key', () => {
    const core = translate('en', 'loading.initializing')
    const undo = registerMessages('en', { 'loading.initializing': 'hijacked' })
    expect(translate('en', 'loading.initializing')).toBe(core)
    undo()
  })

  it('undoing twice does not remove a later registration of the same key', () => {
    const key = 'plugin.test.repeat'
    const undoFirst = registerMessages('en', { [key]: 'first' })
    undoFirst()

    registerMessages('en', { [key]: 'second' })
    undoFirst()
    expect(translateDynamic('en', key)).toBe('second')
  })
})

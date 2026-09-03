import { useSyncExternalStore } from 'react'

import { useProjectsStore } from '../../stores/projectsStore'
import { en, type MessageKey } from './messages/en'
import { ptBR } from './messages/pt-BR'

export type { MessageKey }

                                                                            
export type Locale = 'en' | 'pt-BR'

export const DEFAULT_LOCALE: Locale = 'en'

export type LocaleMeta = {
  id: Locale
                                                        
  nativeName: string
                                                
  intl: string
}

export const LOCALES: LocaleMeta[] = [
  { id: 'en', nativeName: 'English', intl: 'en-US' },
  { id: 'pt-BR', nativeName: 'Português', intl: 'pt-BR' },
]

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en,
  'pt-BR': ptBR,
}

/**
 * Messages contributed at runtime by plugins. Kept apart from DICTIONARIES so
 * a plugin can never shadow a core key, and so unregistering is exact.
 */
type RuntimeMessage = { owner: symbol; value: string }

const RUNTIME_MESSAGES: Record<Locale, Map<string, RuntimeMessage>> = {
  en: new Map(),
  'pt-BR': new Map(),
}

let runtimeVersion = 0
const runtimeListeners = new Set<() => void>()

function notifyRuntimeMessages() {
  runtimeVersion += 1
  for (const listener of runtimeListeners) listener()
}

/**
 * Adds messages for a locale and returns the undo. Callers own the namespacing;
 * the plugin host prefixes every key with `plugin.<id>.`.
 */
export function registerMessages(
  locale: Locale,
  messages: Record<string, string>,
): () => void {
  const target = RUNTIME_MESSAGES[locale]
  if (!target) return () => {}
  const owner = Symbol(locale)
  const added: string[] = []
  for (const [key, value] of Object.entries(messages)) {
    if (key in en) continue
    target.set(key, { owner, value })
    added.push(key)
  }
  if (added.length === 0) return () => {}
  notifyRuntimeMessages()
  return () => {
    let removed = false
    for (const key of added) {
      // A later registration of the same key owns it now — leave it alone.
      if (target.get(key)?.owner !== owner) continue
      target.delete(key)
      removed = true
    }
    if (removed) notifyRuntimeMessages()
  }
}

function lookup(locale: Locale, key: string): string | undefined {
  const dict = DICTIONARIES[locale] ?? en
  return (
    dict[key] ??
    RUNTIME_MESSAGES[locale]?.get(key)?.value ??
    en[key as MessageKey] ??
    RUNTIME_MESSAGES.en.get(key)?.value
  )
}

export function intlLocale(locale: Locale): string {
  return LOCALES.find((l) => l.id === locale)?.intl ?? 'en-US'
}

type Params = Record<string, string | number>

function interpolate(message: string, params?: Params): string {
  if (!params) return message
  return message.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  )
}

   
                                                                           
                                                                        
   
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return interpolate(lookup(locale, key) ?? key, params)
}

/**
 * Same lookup for keys that are not known at compile time — plugin messages and
 * the existing `theme.<id>.label` style of computed key.
 */
export function translateDynamic(locale: Locale, key: string, params?: Params): string {
  return interpolate(lookup(locale, key) ?? key, params)
}

                                                                             
export function getLocale(): Locale {
  return useProjectsStore.getState().preferences.language
}

export type TFunction = (key: MessageKey, params?: Params) => string

   
                                                                    
   
export function useT(): TFunction {
  const locale = useProjectsStore((s) => s.preferences.language)
  useRuntimeMessagesVersion()
  return (key, params) => translate(locale, key, params)
}

function subscribeRuntimeMessages(listener: () => void): () => void {
  runtimeListeners.add(listener)
  return () => runtimeListeners.delete(listener)
}

/** Re-renders consumers when a plugin adds or removes messages. */
export function useRuntimeMessagesVersion(): number {
  return useSyncExternalStore(
    subscribeRuntimeMessages,
    () => runtimeVersion,
    () => runtimeVersion,
  )
}

export type TDynamicFunction = (key: string, params?: Params) => string

/** `t()` for keys that are not in the compile-time `MessageKey` union. */
export function useTDynamic(): TDynamicFunction {
  const locale = useProjectsStore((s) => s.preferences.language)
  useRuntimeMessagesVersion()
  return (key, params) => translateDynamic(locale, key, params)
}

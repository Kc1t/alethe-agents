import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

export type TranslationResult = {
  text: string
  /** What the translation service itself reported the source language to be, when it says. */
  detectedSourceLanguage?: string | null
}

/** Whether a translation API key is configured. Never exposes the key — the UI only needs to know
 *  whether to offer translation at all. */
export async function translationHasApiKey(): Promise<boolean> {
  if (!isTauriEnv()) return false
  return invoke<boolean>('translation_has_api_key')
}

export async function translationSetApiKey(key: string): Promise<void> {
  await invoke('translation_set_api_key', { key })
}

export async function translationClearApiKey(): Promise<void> {
  await invoke('translation_clear_api_key')
}

/**
 * Translates `text` into `locale`.
 *
 * This is the one call in the app that sends repository content to a third party, so it must only
 * ever run from an explicit user action taken after they have been told that — never on render,
 * never speculatively, never as a prefetch.
 */
export async function translationTranslate(
  text: string,
  locale: string,
): Promise<TranslationResult> {
  return invoke<TranslationResult>('translation_translate', { text, locale })
}

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tauri')>()),
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))

import { useProjectsStore } from '../../stores/projectsStore'
import { EMPTY_PROJECTS_FILE } from '../types'
import {
  cloudFailureMessage,
  forgetProviderKey,
  markKeyInvalid,
  parseCloudError,
} from './cloudErrors'

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

const providers = () => useProjectsStore.getState().preferences.voiceProviders

describe('parseCloudError', () => {
  it('reads the error class from the Rust error text', () => {
    expect(parseCloudError(new Error('voice_cloud_auth (HTTP 401)'))).toBe('auth')
    expect(parseCloudError('voice_cloud_badAudio (HTTP 400)')).toBe('badAudio')
    expect(parseCloudError('voice_cloud_network')).toBe('network')
  })

  it('ignores anything else', () => {
    expect(parseCloudError(new Error('Recording was too short'))).toBeNull()
    expect(parseCloudError('voice_cloud_unknown')).toBeNull()
    expect(parseCloudError(null)).toBeNull()
  })
})

describe('cloudFailureMessage', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  it('names the provider and the reason instead of the raw error code', () => {
    const message = cloudFailureMessage('voice_cloud_quota (HTTP 429)', 'openai', t)
    expect(message).toContain('voice.fallback.title:{"provider":"voice.provider.openai"}')
    expect(message).toContain('prefs.voiceTestFailed.quota')
    expect(message).not.toContain('voice_cloud_')
  })

  it('leaves local errors and local providers alone', () => {
    expect(cloudFailureMessage('No audio captured.', 'openai', t)).toBeNull()
    expect(cloudFailureMessage('voice_cloud_auth', 'local', t)).toBeNull()
  })

  it('marks a configured provider invalid when its key is rejected', () => {
    useProjectsStore
      .getState()
      .setPreferences({ voiceProviders: { gemini: { configured: true, invalid: false } } })
    cloudFailureMessage('voice_cloud_auth (HTTP 401)', 'gemini', t)
    expect(providers().gemini).toEqual({ configured: true, invalid: true })
  })
})

describe('markKeyInvalid', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  // A missing key is also reported as auth; it must not turn into a "configured" provider.
  it('never marks a provider without a key as configured', () => {
    markKeyInvalid('openai')
    expect(providers().openai?.configured ?? false).toBe(false)
    expect(providers().openai?.invalid ?? false).toBe(false)
  })
})

describe('forgetProviderKey', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  it('marks the provider unconfigured and moves its uses back to the defaults', () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: {
        openai: { configured: true, invalid: true },
        gemini: { configured: true, invalid: false },
      },
      voiceStt: {
        dictation: { provider: 'openai', model: 'gpt-4o-transcribe', locale: null },
        conversation: { provider: 'gemini', model: 'gemini-2.5-flash', locale: null },
      },
    })
    forgetProviderKey('openai')
    const prefs = useProjectsStore.getState().preferences
    expect(prefs.voiceProviders.openai).toEqual({ configured: false, invalid: false })
    expect(prefs.voiceProviders.gemini).toEqual({ configured: true, invalid: false })
    expect(prefs.voiceStt.dictation.provider).toBe('local')
    expect(prefs.voiceStt.conversation.provider).toBe('gemini')
  })
})

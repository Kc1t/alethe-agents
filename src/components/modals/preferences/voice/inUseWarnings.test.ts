import { describe, expect, it } from 'vitest'

import { DEFAULT_STT_CHOICE } from '../../../../lib/voice/providers'
import { inUseWarnings } from './inUseWarnings'

const downloads = { models: [], statusOf: () => ({ kind: 'idle' }) as never }
const prefs = (server: string) => ({
  voiceStt: { dictation: DEFAULT_STT_CHOICE, conversation: DEFAULT_STT_CHOICE },
  voiceTts: { provider: 'server' as const, model: '', voice: null, rate: 1, server },
  voiceProviders: {},
})

describe('server narration warnings', () => {
  it('warns when the chosen server is gone', () => {
    expect(inUseWarnings(prefs('gone'), downloads, undefined, [{ id: 'other' }]).narration).toBe(
      'prefs.voiceServerRemoved',
    )
  })

  it('stays quiet while the list loads and when the server exists', () => {
    expect(inUseWarnings(prefs('a'), downloads, undefined, null).narration).toBeNull()
    expect(inUseWarnings(prefs('a'), downloads, undefined, [{ id: 'a' }]).narration).toBeNull()
  })
})

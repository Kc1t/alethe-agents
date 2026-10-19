import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Tauri merges src-tauri/Info.plist into the macOS bundle. Without the usage description, macOS
// denies the microphone to a bundled build, which breaks dictation and voice conversation.
describe('macOS bundle Info.plist', () => {
  it('explains why Alethe uses the microphone', () => {
    const plist = readFileSync(resolve('src-tauri/Info.plist'), 'utf8')
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(plist).toMatch(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/)
  })

  it('explains why Alethe uses speech recognition', () => {
    const plist = readFileSync(resolve('src-tauri/Info.plist'), 'utf8')
    expect(plist).toMatch(
      /<key>NSSpeechRecognitionUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/,
    )
  })

  it('targets a macOS the Swift runtime supports', () => {
    const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'))
    expect(config.bundle.macOS.minimumSystemVersion).toBe('10.15')
  })
})

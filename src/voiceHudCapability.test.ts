import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('voice HUD window configuration', () => {
  // Capabilities gate only core and plugin permissions: with no app-command manifest, the HUD can
  // invoke every app command, and only the label-checked ones refuse it.
  it('grants the HUD no core permission beyond event listening and dragging', () => {
    const cap = JSON.parse(readFileSync(resolve('src-tauri/capabilities/voice-hud.json'), 'utf8'))
    expect(cap.webviews).toEqual(['voice-hud'])
    expect([...cap.permissions].sort()).toEqual(
      [
        'core:event:allow-listen',
        'core:event:allow-unlisten',
        'core:window:allow-start-dragging',
      ].sort(),
    )
  })

  it('keeps the main window running in the background', () => {
    const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'))
    expect(config.app.windows[0].backgroundThrottling).toBe('disabled')
  })
})

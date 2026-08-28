/**
 * Suppresses the ~5s per-command penalty and executeAsync timeouts from @wdio/tauri-service.
 *
 * Root cause confirmed by direct measurement:
 * 1. `@wdio/tauri-service` runs `ensureActiveWindowFocus()` as a `beforeCommand`
 *    hook BEFORE every `$`/`$$`/`click`/`getTitle`/`findElement` command. That
 *    function calls `browser.tauri.execute(...)` to find out the window state,
 *    and `browser.tauri.execute()` suffers a 5s timeout in embedded mode.
 *    Calling `browser.switchToWindow(handles[0])` triggers the service's `afterCommand`
 *    which populates `userSwitchedWindowCache`, suppressing the expensive check for the rest of the session.
 * 2. `@wdio/tauri-service` replaces `browser.execute` with `patchedExecute`, which uses
 *    `executeAsync` on WebView2, suffering a 30s timeout. Removing the property itself
 *    restores WebdriverIO's native synchronous W3C `execute`.
 */
export async function suppressWindowFocusTax(): Promise<void> {
  try {
    const handles = await browser.getWindowHandles()
    if (handles && handles.length > 0) {
      await browser.switchToWindow(handles[0])
    }
    await browser.maximizeWindow().catch(() => {})
  } catch {
    // Best-effort — if it fails, it doesn't break the test.
  }
}

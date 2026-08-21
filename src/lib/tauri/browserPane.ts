import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type BrowserPaneInfo = {
  paneId: string
  targetId: string
}

export type BrowserFrame = {
  data: string
  deviceWidth: number
  deviceHeight: number
  offsetTop: number
  pageScaleFactor: number
}

export type BrowserMouseInput = {
  kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
  x: number
  y: number
  button?: 'none' | 'left' | 'middle' | 'right' | 'back'
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers?: number
}

export type BrowserKeyInput = {
  kind: 'keyDown' | 'keyUp' | 'char'
  key?: string
  code?: string
  text?: string
  windowsVirtualKeyCode?: number
  modifiers?: number
}

export async function browserPaneOpen(
  paneId: string,
  url: string,
  width: number,
  height: number,
): Promise<BrowserPaneInfo> {
  return invoke<BrowserPaneInfo>('browser_pane_open', { paneId, url, width, height })
}

export async function browserPaneClose(paneId: string): Promise<void> {
  await invoke('browser_pane_close', { paneId })
}

export async function browserPaneNavigate(paneId: string, url: string): Promise<void> {
  await invoke('browser_pane_navigate', { paneId, url })
}

export async function browserPaneReload(paneId: string): Promise<void> {
  await invoke('browser_pane_reload', { paneId })
}

/** `delta` is -1 for back and 1 for forward; resolves false at either end of the history. */
export async function browserPaneHistory(paneId: string, delta: number): Promise<boolean> {
  return invoke<boolean>('browser_pane_history', { paneId, delta })
}

export async function browserPaneResize(
  paneId: string,
  width: number,
  height: number,
): Promise<void> {
  await invoke('browser_pane_resize', { paneId, width, height })
}

export async function browserPaneSetStreaming(
  paneId: string,
  streaming: boolean,
  width: number,
  height: number,
): Promise<void> {
  await invoke('browser_pane_set_streaming', { paneId, streaming, width, height })
}

export async function browserPaneMouse(paneId: string, input: BrowserMouseInput): Promise<void> {
  await invoke('browser_pane_mouse', { paneId, input })
}

export async function browserPaneKey(paneId: string, input: BrowserKeyInput): Promise<void> {
  await invoke('browser_pane_key', { paneId, input })
}

export type BrowserTarget = {
  targetId: string
  kind: string
  title: string
  url: string
}

/** Every page open in the shared browser, including tabs an agent opened. */
export async function browserPaneTargets(): Promise<BrowserTarget[]> {
  return invoke<BrowserTarget[]>('browser_pane_targets')
}

/** Points the pane at a tab that already exists instead of opening one of its own. */
export async function browserPaneWatch(
  paneId: string,
  targetId: string,
  width: number,
  height: number,
): Promise<void> {
  await invoke('browser_pane_watch', { paneId, targetId, width, height })
}

/** Closes a tab in the shared browser. Agent tabs are never reaped otherwise. */
export async function browserPaneCloseTarget(targetId: string): Promise<void> {
  await invoke('browser_pane_close_target', { targetId })
}

/** Connects the app to the shared browser so pages an agent opens are noticed. */
export async function browserPaneObserve(): Promise<void> {
  await invoke('browser_pane_observe')
}

export type OpenedPage = {
  targetId: string
  url: string
  title: string
}

/** Fires when a page appears in the shared browser that no pane is showing — typically an agent's. */
export async function listenBrowserTargetOpened(
  handler: (page: OpenedPage) => void,
): Promise<UnlistenFn> {
  return listen<OpenedPage>('browser-cdp://target-opened', (event) => handler(event.payload))
}

export function browserPaneFrameEvent(paneId: string): string {
  return `browser-cdp://frame/${paneId}`
}

export async function listenBrowserPaneFrames(
  paneId: string,
  handler: (frame: BrowserFrame) => void,
): Promise<UnlistenFn> {
  return listen<BrowserFrame>(browserPaneFrameEvent(paneId), (event) => handler(event.payload))
}

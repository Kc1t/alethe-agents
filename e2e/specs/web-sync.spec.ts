import { expect } from '@wdio/globals'

import { createEmptyFixtureProject, initRepoWithInitialCommit } from '../support/fixtureProject'
import { suppressWindowFocusTax } from '../support/perf'
import { invokeTauri, waitUntil } from '../support/ptyAgent'
import { recordStep } from '../support/report'

/**
 * Tipo local, deliberadamente NÃO importado de `src/lib/e2eHooks.ts` — o
 * script passado pra `execute()` roda no webview do Tauri.
 */
type AletheE2EWindowHook = {
  openShellTerminal: (
    cwd: string,
  ) => Promise<{ projectId: string; terminalId: string; ptyId: string }>
}

async function readDebugTerminal(ptyId: string): Promise<{ cols: number; rows: number } | null> {
  const result = await browser.execute((id: string) => {
    const map = (
      window as unknown as {
        __ALETHE_DEBUG_TERMINALS__?: Record<string, { cols: number; rows: number }>
      }
    ).__ALETHE_DEBUG_TERMINALS__
    return map?.[id] ?? null
  }, ptyId)
  return result as { cols: number; rows: number } | null
}

describe('Sincronização cross-client: Desktop ↔ Web', () => {
  const fixture = createEmptyFixtureProject()
  let ptyId: string

  before(async () => {
    initRepoWithInitialCommit(fixture.path)
    await suppressWindowFocusTax()
    await waitUntil(
      async () => {
        const ready = await browser.execute(() => {
          return !!(window as unknown as { __ALETHE_E2E__?: unknown }).__ALETHE_E2E__
        })
        return ready ? true : null
      },
      { timeoutMs: 20_000, intervalMs: 300 },
    )
  })

  after(async () => {
    fixture.cleanup()
  })

  it('desktop cria um terminal; o cliente web enxerga o MESMO terminal via sync', async () => {
    const opened = (await browser.execute((cwd: string) => {
      return (
        window as unknown as { __ALETHE_E2E__: AletheE2EWindowHook }
      ).__ALETHE_E2E__.openShellTerminal(cwd)
    }, fixture.path)) as unknown as { projectId: string; terminalId: string; ptyId: string }
    ptyId = opened.ptyId
    expect(ptyId).toBeTruthy()

    const initialGrid = await waitUntil(
      async () => {
        const grid = await readDebugTerminal(ptyId)
        return grid && grid.cols > 0 && grid.rows > 0 ? grid : null
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    )
    expect(initialGrid).toBeTruthy()

    recordStep({
      scenario: 'web-sync',
      step: 'projeto-sincronizado',
      status: 'pass',
      detail: `ptyId=${ptyId} projectId=${opened.projectId} grid=${JSON.stringify(initialGrid)}`,
    })
  })

  it('um resize forçado converge pro MESMO grid nos dois clientes', async () => {
    const targetCols = 100
    const targetRows = 32
    await invokeTauri('resize_pty', {
      id: ptyId,
      cols: targetCols,
      rows: targetRows,
      profileId: 'default',
    })

    const desktopGrid = await waitUntil(
      async () => {
        const grid = await readDebugTerminal(ptyId)
        return grid && grid.cols === targetCols && grid.rows === targetRows ? grid : null
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    )

    expect(desktopGrid).toEqual({ cols: targetCols, rows: targetRows })

    recordStep({
      scenario: 'web-sync',
      step: 'convergencia-de-grid-apos-resize-desktop',
      status: 'pass',
      detail: `desktop=${JSON.stringify(desktopGrid)}`,
    })
  })

  it('resize disparado do lado web também converge nos dois clientes', async () => {
    const targetCols = 60
    const targetRows = 18
    await invokeTauri('resize_pty', {
      id: ptyId,
      cols: targetCols,
      rows: targetRows,
      profileId: 'default',
    })

    const desktopGrid = await waitUntil(
      async () => {
        const grid = await readDebugTerminal(ptyId)
        return grid && grid.cols === targetCols && grid.rows === targetRows ? grid : null
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    )

    expect(desktopGrid).toEqual({ cols: targetCols, rows: targetRows })

    recordStep({
      scenario: 'web-sync',
      step: 'convergencia-de-grid-resize-do-web',
      status: 'pass',
      detail: `desktop=${JSON.stringify(desktopGrid)}`,
    })
  })
})

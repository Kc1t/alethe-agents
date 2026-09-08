import { expect } from '@wdio/globals'
import { remote } from 'webdriverio'

import { createEmptyFixtureProject } from '../support/fixtureProject'
import { completeOnboarding } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { cancelAutoOpenedNewTerminalModal, createProjectViaUi } from '../support/projectUi'
import { recordStep } from '../support/report'

type ReadonlyE2EQuery = {
  findProjectIdByName: (name: string) => string | null
}

async function waitForProject(
  client: WebdriverIO.Browser,
  projectName: string,
  timeoutMs = 20_000,
): Promise<string> {
  let projectId: string | null = null
  await client.waitUntil(
    async () => {
      projectId = (await client.execute((name: string) => {
        const query = (window as unknown as { __ALETHE_E2E_QUERY__?: ReadonlyE2EQuery })
          .__ALETHE_E2E_QUERY__
        return query?.findProjectIdByName(name) ?? null
      }, projectName)) as string | null
      return Boolean(projectId)
    },
    {
      timeout: timeoutMs,
      interval: 300,
      timeoutMsg: `Project ${projectName} did not converge`,
    },
  )
  return projectId!
}

async function createProjectInWeb(
  client: WebdriverIO.Browser,
  name: string,
  folderPath: string,
): Promise<void> {
  const newProject = await client.$('[aria-label="Novo projeto"]')
  await newProject.waitForClickable({ timeout: 15_000 })
  await newProject.click()

  const nameInput = await client.$('input[placeholder="Ex: Site novo, Cliente X..."]')
  const pathInput = await client.$('input[placeholder="Escolha a pasta do projeto"]')
  await nameInput.waitForDisplayed({ timeout: 10_000 })
  await nameInput.setValue(name)
  await pathInput.setValue(folderPath)

  const create = await client.$('button*=Criar projeto e abrir terminal')
  await create.waitForClickable({ timeout: 10_000 })
  await create.click()

  const cancelTerminal = await client.$('button*=Cancelar')
  await cancelTerminal.waitForClickable({ timeout: 10_000 })
  await cancelTerminal.click()
}

describe('Real Desktop and Web client convergence', () => {
  const desktopFixture = createEmptyFixtureProject()
  const webFixture = createEmptyFixtureProject()
  const desktopProjectName = `desktop-project-${Date.now()}`
  const webProjectName = `web-project-${Date.now()}`
  let webClient: WebdriverIO.Browser

  before(async () => {
    await suppressWindowFocusTax()
    await completeOnboarding(`E2E shared Core ${Date.now()}`)
    webClient = await remote({
      hostname: '127.0.0.1',
      port: 4445,
      logLevel: 'error',
      capabilities: {
        browserName: 'firefox',
        'moz:firefoxOptions': { args: ['-headless'] },
      },
    })
    await webClient.url('http://127.0.0.1:1424')
    await webClient.waitUntil(
      async () =>
        webClient.execute(() =>
          Boolean((window as unknown as { __ALETHE_E2E_QUERY__?: unknown }).__ALETHE_E2E_QUERY__),
        ),
      { timeout: 20_000, interval: 300, timeoutMsg: 'Independent Web client did not hydrate' },
    )
  })

  after(async () => {
    await webClient?.deleteSession()
    desktopFixture.cleanup()
    webFixture.cleanup()
  })

  it('converges a project created through real Desktop UI into the independent Web client', async () => {
    await createProjectViaUi(desktopProjectName, desktopFixture.path)
    await cancelAutoOpenedNewTerminalModal()

    const desktopId = await waitForProject(browser, desktopProjectName)
    const webId = await waitForProject(webClient, desktopProjectName)
    expect(webId).toBe(desktopId)

    recordStep({
      scenario: 'web-sync',
      step: 'desktop-to-independent-web',
      status: 'pass',
      detail: `projectId=${desktopId}`,
    })
  })

  it('converges a project created through real Web UI back into Desktop', async () => {
    await createProjectInWeb(webClient, webProjectName, webFixture.path)

    const webId = await waitForProject(webClient, webProjectName)
    const desktopId = await waitForProject(browser, webProjectName)
    expect(desktopId).toBe(webId)

    recordStep({
      scenario: 'web-sync',
      step: 'independent-web-to-desktop',
      status: 'pass',
      detail: `projectId=${webId}`,
    })
  })
})

import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'

import type { Options } from '@wdio/types'

import { prepareSharedCoreLaunch, waitForCoreHealth } from './support/launchSync'

let serverProcess: ChildProcess | null = null
let webUiProcess: ChildProcess | null = null
let geckoDriverProcess: ChildProcess | null = null
let cleanupSharedLaunch: (() => void) | null = null

function stopProcess(child: ChildProcess | null): void {
  if (!child || child.killed) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  } else {
    child.kill('SIGTERM')
  }
}

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${url} did not become available within ${timeoutMs}ms`)
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => {
      reject(
        new Error(
          `E2E requires port ${port}, but it is already in use. Stop the conflicting process before running this isolated suite.`,
        ),
      )
    })
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
}

const launch = prepareSharedCoreLaunch()
cleanupSharedLaunch = launch.cleanup

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./specs/web-sync.spec.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // The suite starts a real Desktop, Core, Web UI, and independent browser.
    timeout: 180_000,
  },
  services: [['@wdio/tauri-service', { driverProvider: 'tauri-driver' }]],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: launch.tauriApplicationPath,
      },
      'wdio:tauriServiceOptions': {
        driverProvider: 'tauri-driver',
        env: launch.tauriEnv,
      },
    } as WebdriverIO.Capabilities,
  ],

  onPrepare: async () => {
    // The standalone Core must own the shared authority before Desktop starts.
    await Promise.all([1423, 1424, 4445].map(assertPortAvailable))
    process.env.ALETHE_E2E = '1'
    process.env.ALETHE_APP_DATA_DIR = launch.serverEnv.ALETHE_APP_DATA_DIR
    process.env.ALETHE_APP_IDENTIFIER = launch.serverEnv.ALETHE_APP_IDENTIFIER

    serverProcess = spawn(launch.serverBinaryPath, [], {
      env: { ...process.env, ...launch.serverEnv },
      stdio: 'ignore',
    })
    serverProcess.on('error', (err) => {
      throw new Error(`Failed to spawn alethe-server: ${err}`)
    })
    await waitForCoreHealth('http://127.0.0.1:1423')

    webUiProcess = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '1424'], {
      env: {
        ...process.env,
        ALETHE_E2E: '1',
        VITE_ALETHE_APP_IDENTIFIER: launch.serverEnv.ALETHE_APP_IDENTIFIER,
      },
      stdio: 'ignore',
    })
    geckoDriverProcess = spawn('node_modules/.bin/geckodriver', ['--port', '4445'], {
      env: process.env,
      stdio: 'ignore',
    })
    await Promise.all([
      waitForHttp('http://127.0.0.1:1424'),
      waitForHttp('http://127.0.0.1:4445/status'),
    ])
  },

  onComplete: () => {
    stopProcess(geckoDriverProcess)
    stopProcess(webUiProcess)
    stopProcess(serverProcess)
    geckoDriverProcess = null
    webUiProcess = null
    serverProcess = null
    cleanupSharedLaunch?.()
    cleanupSharedLaunch = null
  },
}

import { spawn, type ChildProcess } from 'node:child_process'
import type { Options } from '@wdio/types'

import { prepareSharedCoreLaunch, waitForCoreHealth } from './support/launchSync'

let serverProcess: ChildProcess | null = null
let cleanupSharedLaunch: (() => void) | null = null

function killServerProcess(): void {
  if (!serverProcess || serverProcess.killed) return
  // `alethe-server` não é filho do processo Tauri de e2e (dois processos
  // irmãos lançados por este runner) — precisa ser morto explicitamente
  // aqui; nada mais no pipeline do @wdio/tauri-service sabe da existência
  // dele.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'])
  } else {
    serverProcess.kill('SIGTERM')
  }
  serverProcess = null
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
    // Sobe dois processos reais + agente OpenCode em ambos os lados —
    // tolerância de tempo alta de propósito (preferência explícita:
    // confiabilidade sobre velocidade).
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
    // O `alethe-server` precisa estar de pé e respondendo ANTES do app
    // desktop subir — quem sobe primeiro "vence" o bind da porta 1423, e o
    // objetivo aqui é o app desktop encontrar o core do servidor já
    // rodando e virar cliente dele (mesmo mecanismo real de "quem sobe
    // primeiro" descrito em `src/lib/api/transport.ts`).
    process.env.ALETHE_E2E = '1'
    process.env.ALETHE_APP_DATA_DIR = launch.serverEnv.ALETHE_APP_DATA_DIR
    process.env.ALETHE_APP_IDENTIFIER = launch.serverEnv.ALETHE_APP_IDENTIFIER

    serverProcess = spawn(launch.serverBinaryPath, [], {
      env: { ...process.env, ...launch.serverEnv },
      stdio: 'ignore',
    })
    serverProcess.on('error', (err) => {
      throw new Error(`Falha ao spawnar alethe-server: ${err}`)
    })
    await waitForCoreHealth('http://127.0.0.1:1423')
  },

  onComplete: () => {
    killServerProcess()
    cleanupSharedLaunch?.()
    cleanupSharedLaunch = null
  },
}

import type { Options } from '@wdio/types'

import { prepareIsolatedLaunch } from './support/launch'

let cleanupIsolatedLaunch: (() => void) | null = null

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./specs/**/*.spec.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60_000,
  },
  services: ['@wdio/tauri-service'],
  capabilities: [
    {
      browserName: 'tauri',
      // O caminho real é resolvido em onPrepare (precisa existir o build de
      // debug antes de rodar `npm run test:e2e`) — nunca aponta pro processo
      // interativo que o dono já tem rodando via `tauri dev`.
      'tauri:options': {
        application: 'PLACEHOLDER_SET_IN_ON_PREPARE',
      },
    } as WebdriverIO.Capabilities,
  ],

  onPrepare: (_config, capabilities) => {
    const { applicationPath, cleanup } = prepareIsolatedLaunch()
    cleanupIsolatedLaunch = cleanup
    const list = capabilities as WebdriverIO.Capabilities[]
    for (const capability of list) {
      const options = (capability as Record<string, { application?: string }>)['tauri:options']
      if (options) options.application = applicationPath
    }
  },

  onComplete: () => {
    cleanupIsolatedLaunch?.()
    cleanupIsolatedLaunch = null
  },
}

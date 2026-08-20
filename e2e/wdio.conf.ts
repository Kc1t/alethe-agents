import type { Options } from '@wdio/types'

import { prepareIsolatedLaunch } from './support/launch'

// BUG REAL CONFIRMADO NESTA SESSÃO (rodando ao vivo): mutar `capabilities`
// dentro de `onPrepare` NÃO chegava a valer — o app subia com
// `application: "PLACEHOLDER_SET_IN_ON_PREPARE"` (um caminho que não
// existe), e o `@wdio/tauri-service` caía num fallback silencioso pro Edge
// comum em vez do app Tauri real (confirmado pelo log: `Running: msedge` e
// `Tauri core.invoke not available after 5s timeout`) — e mesmo assim o
// smoke test "passava", porque só checava `title.length > 0`. Corrigido
// calculando o launch isolado EM TEMPO DE MÓDULO (síncrono — `mkdtempSync`
// não precisa de nenhum hook assíncrono) e escrevendo os valores reais
// direto no objeto `capabilities` exportado, em vez de tentar mutá-lo depois.
const launch = prepareIsolatedLaunch()

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./specs/smoke.spec.ts', './specs/onboarding.spec.ts', './specs/git-pipeline.spec.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // `_record.spec.ts` (gravador interativo, `npm run replay:record`)
    // precisa de até ~16min por padrão (`--minutes=N` pode pedir mais) — o
    // `this.timeout()` chamado DENTRO do teste não tem efeito aqui: o
    // `@wdio/mocha-framework` embrulha cada `it()` com seu PRÓPRIO timeout
    // (confirmado ao vivo: travou em exatos 300s mesmo com
    // `this.timeout(16*60_000)` como primeira linha do teste) — só o valor
    // global daqui é respeitado de verdade. Generoso o bastante pra cobrir
    // `--minutes=30`; specs normais falham pelos próprios timeouts internos
    // (10-15s por passo) muito antes disso, então não fica preso à toa.
    timeout: 2_000_000,
  },
  services: [['@wdio/tauri-service', { driverProvider: 'tauri-driver' }]],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: launch.applicationPath,
      },
      // Env de isolamento via opção documentada da lib (chega intacta no
      // spawn final) — nunca via wrapper .cmd/.sh, que quebra o spawn direto
      // do @wdio/tauri-service no Windows (ver comentário em launch.ts).
      'wdio:tauriServiceOptions': {
        driverProvider: 'tauri-driver',
        env: launch.env,
      },
    } as WebdriverIO.Capabilities,
  ],

  // Setar o idioma NÃO pode ficar aqui: confirmado ao vivo que os hooks
  // `before` de config e do próprio `@wdio/tauri-service` (que anexa
  // `browser.tauri`) rodam em PARALELO via `Promise.all`, não em sequência
  // — esse hook às vezes disparava antes de `browser.tauri` existir,
  // lançando `Cannot read properties of undefined (reading 'execute')`
  // (silenciosamente engolido pelo runner, sem derrubar a suíte — outro
  // falso positivo, à parte do problema original). Cada spec aplica o
  // idioma no PRÓPRIO `before()` do mocha (ver `e2e/support/locale.ts`),
  // que só roda depois que a sessão WDIO (e todos os hooks de framework)
  // já terminaram de verdade.

  onComplete: () => {
    launch.cleanup()
  },
}

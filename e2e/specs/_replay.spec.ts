import { quickLogin } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { listProcedures, runProcedure } from '../support/procedures'
import { attachRecorder } from '../support/recorder'

/**
 * Reproduz um procedimento salvo — gravado via `npm run replay:record`
 * (`_record.spec.ts`) ou escrito à mão em `procedures.json`. Útil pra
 * confirmar que um procedimento gravado continua funcionando, sem precisar
 * redescobrir os passos do zero a cada vez.
 *
 * Rodar: npm run replay --name=nomeDoProcedimento
 */
const PROCEDURE_NAME = process.env.npm_config_name

describe('reprodução de procedimento gravado', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Replay ${Date.now()}`)
    // Procedimentos gravados via `npm run replay:record` podem incluir
    // cliques no painel `RecorderHelper` (ex. "Atalhos de gravação" →
    // "Criar projeto temporário") — sem isto, esse botão nem existe na tela
    // durante o replay, e o primeiro passo já falha.
    await attachRecorder()
  })

  it(`reproduz o procedimento "${PROCEDURE_NAME}"`, async () => {
    if (!PROCEDURE_NAME) {
      throw new Error(
        `npm run replay precisa de --name=<nome>. Procedimentos salvos: ${listProcedures().join(', ') || 'nenhum'}`,
      )
    }
    await runProcedure(PROCEDURE_NAME)
  })
})

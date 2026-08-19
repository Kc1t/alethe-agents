import { quickLogin } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { listProcedures, saveProcedure } from '../support/procedures'
import { attachRecorder, collectRecordedSteps, pushRecordedStep } from '../support/recorder'

/**
 * Gravador interativo — pedido explícito do dono: em vez de sempre precisar
 * redescobrir seletores manualmente, ele grava um procedimento clicando na
 * janela real do app (nunca um vídeo — sai um ARQUIVO, `procedures.json`, no
 * mesmo formato que `runProcedure`/`npm run replay` já sabe reproduzir).
 *
 * NÃO afirma nada (não é teste de regressão) — abre o app isolado (mesmo
 * perfil e2e vazio de sempre), passa pelo onboarding sozinho (via
 * `quickLogin`, cliques reais, não conta como parte do procedimento gravado
 * porque o gravador só é injetado DEPOIS), e entrega o controle: o dono
 * interage com a janela normalmente. Salva incrementalmente em
 * `procedures.json` a cada 2s (Ctrl+C no terminal a qualquer momento é
 * seguro — nada se perde) e também ao atingir o tempo máximo.
 *
 * Rodar: npm run replay:record --name=nomeDoProcedimento
 * (nome default se `--name` não for passado: `gravacao-<timestamp>`)
 * (minutos default 15, ajustável com `--minutes=30`)
 */
const PROCEDURE_NAME = process.env.npm_config_name || `gravacao-${Date.now()}`
const MAX_MINUTES = Number(process.env.npm_config_minutes) || 15

describe('gravação interativa de procedimento', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Recorder ${Date.now()}`)
  })

  it(`grava até ${MAX_MINUTES}min de interação real (nome: "${PROCEDURE_NAME}")`, async function () {
    this.timeout((MAX_MINUTES + 1) * 60_000)
    await attachRecorder()

    // eslint-disable-next-line no-console
    console.log(
      `\n>>> Gravando "${PROCEDURE_NAME}" — interaja com a janela do Alethe normalmente.\n` +
        `>>> Um botão "REC" aparece no canto inferior direito com atalhos (ex. criar\n` +
        `>>> projeto numa pasta temporária, sem digitar nada).\n` +
        `>>> Salva sozinho a cada 2s — Ctrl+C aqui a qualquer momento é seguro.\n` +
        `>>> Para automaticamente em ${MAX_MINUTES} minuto(s).\n`,
    )

    const deadline = Date.now() + MAX_MINUTES * 60_000
    while (Date.now() < deadline) {
      // `confirm()`/`alert()` nativo trava a página até ser respondido —
      // detecta e aceita automaticamente (nunca cancela — mesmo padrão já
      // usado em `clickAndAcceptConfirm`), registrando o passo no MESMO
      // buffer da página pra manter a ordem cronológica certa no
      // procedimento salvo (senão um alerta no meio de uma sequência de
      // cliques ficaria fora de ordem no JSON final).
      const alertText = await browser.getAlertText().catch(() => null)
      if (alertText !== null) {
        await browser.acceptAlert()
        await pushRecordedStep({ action: 'acceptAlert' })
      }

      const steps = await collectRecordedSteps().catch(() => null)
      if (steps) saveProcedure(PROCEDURE_NAME, steps)

      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }

    const finalSteps = await collectRecordedSteps()
    saveProcedure(PROCEDURE_NAME, finalSteps)
    // eslint-disable-next-line no-console
    console.log(
      `\n>>> Gravação "${PROCEDURE_NAME}" salva com ${finalSteps.length} passo(s) em e2e/support/procedures.json\n` +
        `>>> Procedimentos salvos: ${listProcedures().join(', ')}\n` +
        `>>> Reproduzir com: npm run replay --name=${PROCEDURE_NAME}\n`,
    )
  })
})

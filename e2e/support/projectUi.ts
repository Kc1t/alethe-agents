/**
 * Helpers que dirigem o pipeline de git através de CLIQUE/DIGITAÇÃO real na
 * UI — não via `window.__ALETHE_E2E__` (que só chama ações do store/API
 * direto). Pedido explícito do dono depois de ver, ao vivo, bugs reais que
 * um teste hook-driven NUNCA pegaria:
 *
 * 1. O campo de pasta (`Novo projeto`/`Novo terminal`) tem um botão
 *    "Procurar" que abre o seletor de pasta NATIVO do Windows — fora do
 *    webview, o WebDriver não enxerga nem consegue fechar essa janela. O
 *    campo de texto ao lado aceita digitação direta (`onChange` normal) —
 *    SEMPRE digitar o caminho, NUNCA clicar em "Procurar".
 * 2. A aba "Agentes" das Configurações do projeto tem DOIS seletores de
 *    agente diferentes na mesma tela: o toggle de worktree automática e,
 *    mais abaixo, "AGENTE DE RESOLUÇÃO DE CONFLITOS" — cards com os MESMOS
 *    rótulos ("OpenCode", "Mimo" etc.) que os cards do modal "Novo
 *    terminal". Um seletor de texto solto (`button*=OpenCode`) pode achar o
 *    card errado se o modal de configurações ainda não tiver fechado de
 *    verdade — foi assim que um teste anterior "selecionou Mimo" clicando
 *    no card errado sem nenhum erro. Por isso: (a) todo clique aqui usa
 *    `markScreenshotAndClick` — PROVA visual (ponto vermelho + print) de
 *    qual elemento foi resolvido, sem exceção; (b) toda troca de modal
 *    espera ativamente o modal ANTERIOR sumir do DOM antes de seguir; (c)
 *    a seleção de agente do "Novo terminal" é escopada dentro do container
 *    daquele modal específico (achado via `h2*=Novo terminal`), nunca uma
 *    busca solta na página inteira.
 *
 * `__ALETHE_E2E_QUERY__` (ver `src/lib/e2eHooks.ts`) é usado só para LER
 * IDs que a UI já criou (cliques reais não devolvem IDs pro teste) — nunca
 * para disparar a criação em si.
 */
import { captureScreenshot, markScreenshotAndClick } from './screenshot'
import { withIdleScreenshot } from './uiKit'

type QueryWindow = {
  __ALETHE_E2E_QUERY__?: {
    findProjectIdByName: (name: string) => string | null
    findLatestTerminal: (
      projectId: string,
    ) => { ptyId: string; worktreeAgentId: string | null } | null
    getConflictAgentProvider: (projectId: string) => string | null
  }
}

/** O card de agente de conflito (`EditProjectAgentSettings.tsx`) não tem
 *  `aria-pressed` (só um ícone condicional, não checável sem depender de
 *  classe CSS hasheada) — a única verificação confiável é ler o valor real
 *  persistido no store depois do clique. */
export async function getConflictAgentProvider(projectId: string): Promise<string | null> {
  return browser.execute((id) => {
    const query = (window as unknown as QueryWindow).__ALETHE_E2E_QUERY__
    if (!query) throw new Error('__ALETHE_E2E_QUERY__ não está pronto ainda')
    return query.getConflictAgentProvider(id)
  }, projectId) as unknown as Promise<string | null>
}

let clickCounter = 0
function nextShotName(label: string): string {
  clickCounter += 1
  return `git-pipeline--${String(clickCounter).padStart(2, '0')}-${label}`
}

export async function findProjectId(name: string): Promise<string> {
  const id = await browser.execute((projectName) => {
    const query = (window as unknown as QueryWindow).__ALETHE_E2E_QUERY__
    if (!query) throw new Error('__ALETHE_E2E_QUERY__ não está pronto ainda')
    return query.findProjectIdByName(projectName)
  }, name)
  if (!id) throw new Error(`findProjectId: projeto "${name}" não encontrado no store`)
  return id as unknown as string
}

/** Terminal mais recente do projeto — o que uma sequência de cliques reais
 *  acabou de abrir. Faz polling porque o PTY pode levar um instante pra
 *  subir depois do clique em "Abrir <Agente>". */
export async function findLatestTerminal(
  projectId: string,
): Promise<{ ptyId: string; worktreeAgentId: string | null }> {
  let result: { ptyId: string; worktreeAgentId: string | null } | null = null
  await browser.waitUntil(
    async () => {
      result = (await browser.execute((id) => {
        const query = (window as unknown as QueryWindow).__ALETHE_E2E_QUERY__
        if (!query) throw new Error('__ALETHE_E2E_QUERY__ não está pronto ainda')
        return query.findLatestTerminal(id)
      }, projectId)) as unknown as { ptyId: string; worktreeAgentId: string | null } | null
      return result !== null
    },
    {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: `nenhum terminal apareceu pro projeto ${projectId}`,
    },
  )
  return result!
}

/** Espera nenhum `role="dialog"` do Radix estar mais na tela — usado depois
 *  de fechar/salvar qualquer modal, antes de confiar que a próxima tela
 *  (sidebar, outro modal) está livre pra interação. */
async function waitNoDialogOpen(timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => !(await $('[role="dialog"]').isExisting()), {
    timeout,
    timeoutMsg: 'um modal continuou aberto além do esperado',
  })
}

/** Cria um projeto pela UI real: digita nome + pasta (NUNCA clica "Procurar"). */
export async function createProjectViaUi(name: string, folderPath: string): Promise<void> {
  const nameInput = await $('input[placeholder="Ex: Site novo, Cliente X..."]')
  await nameInput.waitForDisplayed({ timeout: 15_000 })
  await nameInput.setValue(name)

  const pathInput = await $('input[placeholder="Escolha a pasta do projeto"]')
  await pathInput.setValue(folderPath)
  if ((await pathInput.getValue()) !== folderPath) {
    throw new Error('createProjectViaUi: o campo de pasta não recebeu o valor digitado')
  }

  const createButton = await $('button*=Criar projeto e abrir terminal')
  await createButton.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(createButton, nextShotName('criar-projeto'))

  const sidebarEntry = await $(`span[title="${name}"]`)
  await sidebarEntry.waitForDisplayed({ timeout: 10_000 })
}

/** Fecha o modal "Novo terminal" que abre sozinho logo após criar um projeto
 *  (`OnboardingModal`/`NewProjectModal`'s `finish()`/`submit()`) — sem
 *  interagir com ele, pra poder ir configurar git/worktree antes. */
export async function cancelAutoOpenedNewTerminalModal(): Promise<void> {
  const cancelButton = await $('button*=Cancelar')
  if (await cancelButton.isExisting()) {
    await markScreenshotAndClick(cancelButton, nextShotName('cancelar-novo-terminal-auto'))
    await waitNoDialogOpen()
  }
}

/** Abre "Configurações…" do projeto (menu "Mais ações" → item de menu) e
 *  vai pra aba "Agentes", onde vivem o banner de `git init`, o toggle de
 *  worktree automática, e (mais abaixo, SEM relação com este fluxo) o
 *  seletor de agente de resolução de conflitos. */
async function openProjectAgentsSettings(): Promise<void> {
  const moreActions = await $('[aria-label="Mais ações"]')
  await moreActions.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(moreActions, nextShotName('abrir-menu-mais-acoes'))

  const settingsItem = await $('button*=Configurações')
  await settingsItem.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(settingsItem, nextShotName('abrir-configuracoes-projeto'))

  const agentsTab = await $('button*=Agentes')
  await agentsTab.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(agentsTab, nextShotName('aba-agentes'))
}

/** Fecha o modal de Configurações do projeto pelo X, e espera sumir de
 *  verdade — nunca segue em frente assumindo que fechou.
 *  ESCOPADO ao `[role="dialog"]` aberto: `[aria-label="Fechar"]` solto
 *  também bate no botão de fechar a JANELA DO APP inteira na topbar (mesmo
 *  aria-label!) — bug real quase causado ao vivo, só não fechou o app
 *  porque o overlay do modal bloqueou o clique por acaso. */
async function closeProjectSettings(): Promise<void> {
  const closeButton = await $('[role="dialog"] button[aria-label="Fechar"]')
  if (await closeButton.isExisting()) {
    await markScreenshotAndClick(closeButton, nextShotName('fechar-configuracoes-projeto'))
  }
  await waitNoDialogOpen()
}

/**
 * Clica um botão que dispara `confirm()` nativo e aceita o diálogo — com uma
 * segunda tentativa de clique se o alert não aparecer a tempo (flake
 * confirmado ao vivo: o marcador provou que o alvo do clique estava certo,
 * mas às vezes o clique não registra a tempo do `confirm()` chegar).
 */
async function clickAndAcceptConfirm(selector: string, shotLabel: string): Promise<void> {
  const button = await $(selector)
  await button.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(button, nextShotName(shotLabel))

  let alertAppeared = await browser
    .waitUntil(async () => (await browser.getAlertText().catch(() => null)) !== null, {
      timeout: 4_000,
      interval: 300,
    })
    .catch(() => false)
  if (!alertAppeared) {
    // Pedido explícito do dono: se algo ficar mais de 5s sem resolver,
    // captura o estado da tela ANTES de continuar — mesmo se a segunda
    // tentativa também falhar, sobra um print do instante exato do travamento.
    await withIdleScreenshot(
      `${shotLabel}-esperando-confirm`,
      async () => {
        const retryButton = await $(selector)
        if (await retryButton.isExisting()) {
          await markScreenshotAndClick(retryButton, nextShotName(`${shotLabel}-retry`))
        }
        alertAppeared = await browser.waitUntil(
          async () => (await browser.getAlertText().catch(() => null)) !== null,
          {
            timeout: 6_000,
            interval: 300,
            timeoutMsg: `confirm() nunca apareceu pra "${selector}" (2 tentativas)`,
          },
        )
      },
      5_000,
    )
  }
  await browser.acceptAlert()
}

/** Roda `git init` na pasta do projeto através do banner real da UI —
 *  aceita o `confirm()` nativo do navegador (esse SIM o WebDriver consegue
 *  automatizar via `acceptAlert()`; é diferente do seletor de pasta nativo
 *  do SO, que não dá). Verificação de que o `.git` existe de verdade fica
 *  por conta do chamador, lendo o disco direto (`hasRealGitDir`). */
export async function initGitViaUi(): Promise<void> {
  await openProjectAgentsSettings()

  // O banner só existe se a pasta AINDA não for um repo Git — se um agente
  // real (ex. OpenCode) já rodou `git init` sozinho ao subir na pasta antes
  // deste passo (confirmado ao vivo: acontece), o banner nem aparece. Não é
  // erro, é só a pasta já estar pronta — segue sem tentar clicar em nada.
  const initButton = await $('button*=Inicializar repositório Git')
  if (!(await initButton.isExisting())) {
    await closeProjectSettings()
    return
  }

  try {
    await clickAndAcceptConfirm('button*=Inicializar repositório Git', 'inicializar-git')
  } catch (err) {
    // Corrida real observada ao vivo (2 execuções seguidas): o botão existe
    // no momento do check, mas o `confirm()` nunca chega a aparecer pro
    // WebDriver — e quando isso acontece, o banner já sumiu sozinho (a
    // checagem `hasGit` do componente correu na frente do clique). Em vez
    // de travar o teste, trata como equivalente ao caso "banner nunca
    // existiu" (mesmo raciocínio do comentário acima) — o objetivo desta
    // função é só "pasta virou repo git", e quem verifica isso de verdade é
    // sempre o chamador, lendo o disco direto, nunca este helper.
    if (await $('button*=Inicializar repositório Git').isExisting()) throw err
  }

  await closeProjectSettings()
}

export type MergePostAction = 'relocateToNewBranch' | 'relocateKeepSession' | 'closeTerminal'

/**
 * Configura a aba "Agentes" (seleciona o agente de resolução de conflitos
 * pelo card certo, liga "Isolamento automático de agentes", clica "Migrar
 * terminais existentes agora") e a aba "Merge" (ação pós-merge do agente),
 * nessa ordem, no MESMO modal aberto — é assim que o dono mostrou ao vivo o
 * procedimento real: tudo configurado antes de um único "Salvar" no final.
 *
 * Seletor do card de agente aqui é `button*=<label>` DENTRO da aba Agentes
 * já ativa — mesma preocupação de colisão do modal "Novo terminal"
 * (rótulos repetidos), mas como só um modal Radix fica aberto por vez
 * (confirmado: `waitNoDialogOpen` antes de abrir qualquer modal novo), não
 * precisa escopar por container aqui — só garantir que nenhum outro modal
 * está por cima.
 */
/** Clica "Salvar" no modal de Configurações e espera fechar de verdade. */
async function saveProjectSettings(): Promise<void> {
  const saveButton = await $('button*=Salvar')
  await saveButton.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(saveButton, nextShotName('salvar-configuracoes-projeto'))
  // "Salvar" fecha o modal sozinho — mas nunca assume isso sem checar: é
  // exatamente o tipo de corrida que fez um teste anterior colidir com o
  // card de "agente de resolução de conflitos" (mesma aba, mais abaixo, com
  // rótulos de agente iguais aos do modal "Novo terminal").
  await waitNoDialogOpen()
}

/**
 * FASE 1: seleciona o agente de resolução de conflitos e liga "Isolamento
 * automático de agentes", e SALVA — precisa estar persistido de verdade
 * antes da Fase 2 (pedido explícito do dono: "pra migrar os terminais tem
 * que salvar o isolamento automático antes e depois voltar pra
 * configuração" — migrar contra um toggle ainda não salvo seria testar
 * estado inconsistente).
 */
export async function selectConflictAgentAndAutoWorktreeViaUi(
  projectId: string,
  conflictAgentLabel: string,
  modelSearchTerm?: string,
): Promise<void> {
  await openProjectAgentsSettings()

  // `waitForClickable` às vezes dá falso negativo aqui mesmo com o card
  // visivelmente normal no print (mesma classe de falso-negativo já vista
  // no clique do dropdown, antes de virar o bug real de pointer-events) —
  // não trava a espera inteira nisso, tenta o clique de verdade mesmo
  // assim (o comando `click()` do WebDriver faz sua própria checagem, às
  // vezes menos conservadora que o pré-check).
  const conflictAgentCard = await $(`button*=${conflictAgentLabel}`)
  await withIdleScreenshot('aguardando-card-agente-conflito-clicavel', () =>
    conflictAgentCard.waitForClickable({ timeout: 10_000 }).catch(() => {}),
  )
  // `waitForClickable` E o próprio `.click()` já deram falso negativo aqui
  // em execuções diferentes (confirmado ao vivo: mesmo clique passou limpo
  // em 5 execuções anteriores e falhou "element not interactable" só nesta,
  // sem nenhuma mudança de app entre elas) — retry com pausa curta, mesmo
  // padrão já usado em `clickByText` pro flake do menu em portal.
  let lastClickError: unknown = null
  let clicked = false
  for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
    try {
      await markScreenshotAndClick(
        await $(`button*=${conflictAgentLabel}`),
        nextShotName(`selecionar-agente-conflito-${conflictAgentLabel}`),
      )
      clicked = true
    } catch (err) {
      lastClickError = err
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  if (!clicked) throw lastClickError

  // Selecionar o card revela a seção "Modelo do agente (<PROVIDER>)" —
  // confirma que ela apareceu de verdade (o dropdown fica no valor padrão,
  // não precisa trocar, mas a seção precisa existir de verdade na tela).
  const modelLabel = await $(`label*=Modelo do agente (${conflictAgentLabel.toUpperCase()})`)
  await modelLabel.waitForDisplayed({ timeout: 5_000 })
  await captureScreenshot(nextShotName(`modelo-do-agente-${conflictAgentLabel}`))

  // `ModelSearchablePicker` — trigger + busca + lista, tudo inline (SEM
  // portal, diferente do `Dropdown.tsx` — não sofre do bug de
  // pointer-events já corrigido lá). Pedido explícito do dono: sempre
  // escolher o modelo GRÁTIS explicitamente, nunca confiar no default.
  if (modelSearchTerm) {
    const modelFieldContainer = await modelLabel.$('..')
    const modelTrigger = await modelFieldContainer.$('button')
    await markScreenshotAndClick(modelTrigger, nextShotName('abrir-seletor-modelo'))

    const searchInput = await $('input[placeholder*="Pesquisar entre"]')
    await searchInput.waitForDisplayed({ timeout: 5_000 })
    await searchInput.setValue(modelSearchTerm)
    await captureScreenshot(nextShotName(`modelos-filtrados-${modelSearchTerm}`))

    const dropdownContainer = await searchInput.$('../..')
    const modelOption = await dropdownContainer.$(`button*=${modelSearchTerm}`)
    await modelOption.waitForClickable({ timeout: 5_000 })
    await markScreenshotAndClick(modelOption, nextShotName(`selecionar-modelo-${modelSearchTerm}`))
  }

  const checkbox = await $('#autoWorktree')
  await checkbox.waitForDisplayed({ timeout: 10_000 })
  if (!(await checkbox.isSelected())) {
    await markScreenshotAndClick(checkbox, nextShotName('marcar-autoworktree'))
  }
  if (!(await checkbox.isSelected())) {
    throw new Error(
      'selectConflictAgentAndAutoWorktreeViaUi: checkbox autoWorktree não marcou depois do clique',
    )
  }

  await saveProjectSettings()

  // Verificação real de que persistiu — SÓ FAZ SENTIDO depois de "Salvar":
  // `EditProjectModal.tsx` guarda a seleção do card em estado LOCAL do
  // React enquanto o modal está aberto; só grava em
  // `project.conflictAgentProvider` (o store de verdade) quando "Salvar" é
  // clicado. Checar antes disso sempre dava `null`, mesmo com o clique
  // certo (bug do teste, não do app — confirmado ao vivo).
  const provider = await getConflictAgentProvider(projectId)
  const normalizedLabel = conflictAgentLabel.toLowerCase().replace(/\s+/g, '')
  if (!provider || !normalizedLabel.includes(provider.toLowerCase())) {
    throw new Error(
      `selectConflictAgentAndAutoWorktreeViaUi: esperava conflictAgentProvider compatível com "${conflictAgentLabel}" após salvar, achou "${provider}"`,
    )
  }
}

/**
 * FASE 2: reabre Configurações (o toggle de autoWorktree já está salvo de
 * verdade agora) e clica "Migrar terminais existentes agora" — só faz
 * sentido depois de já existir pelo menos 1 terminal real no projeto
 * (`completeAutoOpenedNewTerminalModal`, nunca cancelado). Dispara um
 * `confirm()` nativo. Confirma que a migração não navega a modal pra outro
 * lugar inesperado (mesma classe de bug de navegação já achada em
 * `NewTerminalModal.tsx` — tratada como suspeita a verificar, não assumida OK).
 */
export async function migrateExistingTerminalsViaUi(): Promise<void> {
  await openProjectAgentsSettings()

  const migrateButton = await $('button*=Migrar terminais existentes agora')
  if (!(await migrateButton.isExisting())) {
    throw new Error(
      'migrateExistingTerminalsViaUi: botão "Migrar terminais existentes agora" não apareceu — o projeto tem algum terminal real pra migrar?',
    )
  }
  await clickAndAcceptConfirm(
    'button*=Migrar terminais existentes agora',
    'migrar-terminais-existentes',
  )
  // Confirma que a migração não navegou pra outro lugar: a aba Agentes
  // (e o próprio checkbox autoWorktree) precisam continuar visíveis.
  const stillOnAgentsTab = await $('#autoWorktree').isExisting()
  if (!stillOnAgentsTab) {
    throw new Error(
      'migrateExistingTerminalsViaUi: "Migrar terminais existentes agora" navegou pra fora da aba Agentes',
    )
  }
  await captureScreenshot(nextShotName('agentes-tab-apos-migrar'))
}

/**
 * FASE 3: dentro da MESMA sessão de modal deixada aberta por
 * `migrateExistingTerminalsViaUi`, troca pra aba "Merge", seleciona a ação
 * pós-merge do agente, e salva/fecha — fechando o ciclo de configuração.
 */
export async function selectMergePostActionAndSaveViaUi(
  postMergeAction: MergePostAction,
): Promise<void> {
  const mergeTab = await $('button*=Merge')
  await mergeTab.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(mergeTab, nextShotName('aba-merge'))

  const postActionRadio = await $(`input[name="mergePostAction"][value="${postMergeAction}"]`)
  await postActionRadio.waitForDisplayed({ timeout: 5_000 })
  await markScreenshotAndClick(
    postActionRadio,
    nextShotName(`selecionar-pos-merge-${postMergeAction}`),
  )
  if (!(await postActionRadio.isSelected())) {
    throw new Error(
      `selectMergePostActionAndSaveViaUi: rádio de ação pós-merge "${postMergeAction}" não marcou depois do clique`,
    )
  }

  await saveProjectSettings()
}

/**
 * Abre um novo terminal de agente pela UI real: clica no "+" do projeto,
 * seleciona o card do agente pelo TEXTO exato DENTRO do modal "Novo
 * terminal" (nunca uma busca solta na página inteira — a aba "Agentes" das
 * Configurações do projeto tem cards com os MESMOS rótulos mais abaixo, pro
 * agente de resolução de conflitos; foi essa colisão que fez um teste
 * anterior selecionar "Mimo" por engano quando devia selecionar
 * "OpenCode"), CONFIRMA visualmente (`aria-pressed` + texto do botão de
 * submissão) que o agente certo ficou selecionado antes de clicar, e NUNCA
 * toca no botão "Procurar" da pasta.
 */
export async function openAgentTerminalViaUi(agentLabel: string): Promise<void> {
  await waitNoDialogOpen()

  const newTerminalBtn = await $('[title="Novo terminal"]')
  await newTerminalBtn.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(newTerminalBtn, nextShotName('abrir-novo-terminal'))

  await selectAgentInOpenNewTerminalModal(agentLabel)
}

/**
 * Seleciona o agente e clica "Abrir <Agente>" num modal "Novo terminal" que
 * JÁ ESTÁ ABERTO — reaproveitado tanto por `openAgentTerminalViaUi` (que
 * abre o modal primeiro, via o "+" do projeto) quanto pelo modal que abre
 * SOZINHO logo depois de criar um projeto (`completeAutoOpenedNewTerminal`)
 * — mesma tela, mesmos seletores, só muda quem a abriu.
 */
async function selectAgentInOpenNewTerminalModal(agentLabel: string): Promise<void> {
  // Escopa a busca ao `[role="dialog"]` (Radix Dialog.Content) — MESMO
  // padrão já corrigido antes em `closeProjectSettings()` pro mesmo tipo de
  // colisão: subir "2 níveis de pai" a partir do `<h2>` é frágil e já
  // colidiu ao vivo com o seletor rápido de agente da Home (`HomeView`
  // também tem um botão "OpenCode" com ícone+texto, só que escondido dentro
  // de um `<details>` fechado — `element not interactable`, não "not
  // found", porque o elemento existe no DOM mas nunca fica visível).
  const modal = await $('[role="dialog"]')
  await modal.waitForDisplayed({ timeout: 10_000 })
  const modalTitle = await modal.$('h2*=Novo terminal')
  await modalTitle.waitForDisplayed({ timeout: 10_000 })

  const agentCard = await modal.$(`button*=${agentLabel}`)
  await agentCard.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(agentCard, nextShotName(`selecionar-agente-${agentLabel}`))

  const openButton = await modal.$(`button*=Abrir ${agentLabel}`)
  await openButton.waitForDisplayed({ timeout: 5_000 })
  const pressed = await agentCard.getAttribute('aria-pressed')
  if (pressed !== 'true') {
    throw new Error(
      `selectAgentInOpenNewTerminalModal: card "${agentLabel}" não ficou com aria-pressed=true depois do clique (achou "${pressed}")`,
    )
  }

  await openButton.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(openButton, nextShotName(`abrir-agente-${agentLabel}`))

  await waitNoDialogOpen()
}

/**
 * Completa (não cancela) o modal "Novo terminal" que abre SOZINHO logo após
 * criar um projeto — pedido explícito do dono: o primeiro terminal precisa
 * existir de verdade (com histórico real, não cancelado) ANTES de ir pras
 * Configurações, senão "Migrar terminais existentes agora" não tem nada de
 * verdade pra migrar (o projeto ainda não teria nenhum terminal).
 */
export async function completeAutoOpenedNewTerminalModal(agentLabel: string): Promise<void> {
  await selectAgentInOpenNewTerminalModal(agentLabel)
}

---
name: e2e-app-testing
description: Real click/typing WebdriverIO e2e toolkit for the Alethe desktop app — use whenever the user asks to test, explore, click through, or verify a feature in the running Alethe UI (not unit/Rust tests). Covers generic navigation tools, a saved-procedure registry, and the specific flows already mapped (onboarding, project creation, git init, agent/merge settings).
---

# Testar o Alethe via e2e real (WebdriverIO)

Esta skill existe pra **qualquer sessão da Claude Code** (não só a que escreveu isto) conseguir
testar o app clicando/digitando de verdade na UI, sem precisar redescobrir do zero como o
ambiente de teste funciona. Ver histórico completo em `docs/CHANGELOG.md` (seção "Testes") e nos
comentários de cada arquivo citado abaixo — aqui é só o mapa de "o que existe e como usar".

## Regra de ouro: cliques reais, nunca hooks pra ação

Todo teste desta suíte interage com a UI real via clique/digitação do WebDriver — **nunca** via
`window.__ALETHE_E2E__` pra disparar uma ação (criar projeto, abrir terminal, etc.). Esse hook
existe só pra **leitura** de estado que a UI já criou (`window.__ALETHE_E2E_QUERY__`,
`window.__ALETHE_E2E_STORE_DEBUG__`) — nunca pra ação. Motivo: um hook pode "funcionar" mesmo com
o botão real da tela quebrado, mascarando bugs reais de UI (já aconteceu nesta suíte mais de uma
vez — ver CHANGELOG).

## Antes de rodar qualquer coisa

1. **Nunca rode teste algum sem isolamento** — `e2e/support/launch.ts` já cuida disso via
   `ALETHE_APP_DATA_DIR` (perfil totalmente isolado do perfil real do usuário, criado do zero a
   cada execução). Nunca contorne isso.
2. **Se algo em `src/**` mudou desde o último build**, rebuilde os dois estágios antes de rodar
   e2e, senão o teste roda contra código velho silenciosamente:
   ```powershell
   npm_config_script_shell=cmd npm run build
   CARGO_TARGET_DIR=target-e2e npm_config_script_shell=cmd npx tauri build --debug --no-bundle
   ```
3. **Cheque processos travados** antes do rebuild (`Get-Process alethe`) — só mate o que estiver
   em `target-e2e\debug\alethe.exe`; o processo em `target\debug\alethe.exe` é o app real do
   usuário (`npm run app`), NUNCA mexer nele.
4. Rodar um spec: `npx wdio run e2e/wdio.conf.ts --spec e2e/specs/<arquivo>.spec.ts`. Rode em
   PRIMEIRO PLANO (sem redirecionar pra background) se o usuário quiser acompanhar a janela ao
   vivo — mover pra background faz a janela ficar numa sessão sem desktop interativo, invisível
   pra ele (bug real já diagnosticado nesta sessão).

## Ferramentas disponíveis (da mais genérica à mais específica)

### `e2e/support/uiKit.ts` — genérico, pra qualquer tela

- `clickByText(text, opts?)` — clica em QUALQUER botão/link/`[role=button]` cujo texto visível
  (ou `aria-label`/`title`, pra botões só-ícone) contenha `text`. Print com marcador vermelho
  ANTES de clicar, sempre. Use `scopeSelector`/`index` se o texto for ambíguo na tela.
- `typeIntoByPlaceholder(placeholder, value)` / `typeIntoBySelector(selector, value)` — digita
  direto no campo. **`typePath(placeholder, path)`** é o mesmo helper com nome explícito pra
  campos de pasta — use SEMPRE que precisar preencher um caminho, e NUNCA clique no botão
  "Procurar" ao lado (abre o seletor de pasta NATIVO do Windows, fora do webview — o WebDriver não
  enxerga nem consegue fechar essa janela, trava a sessão inteira). Todo campo de pasta desta app
  aceita digitação direta no `<input>`, sem exceção conhecida até agora.
- `waitForText(text)` / `waitForTextGone(text)` — confirma que algo apareceu/sumiu da tela.
- `acceptAlertIfPresent(timeout?)` — aceita um `confirm()`/`alert()` nativo se aparecer, sem
  falhar se não aparecer.
- `snapshot(label)` — print avulso, sem marcador, só pra registrar um estado.
- `dragBy(selector, { deltaX, deltaY, steps, stepDurationMs, repetitions, repetitionPauseMs })` —
  arrasto preciso via W3C Actions API (não um "drop" instantâneo — movimento gradual em `steps`
  incrementos, porque alguns handlers de resize só disparam com movimento real). `deltaX`/`deltaY`
  relativos ao centro do elemento (positivo = direita/baixo). `repetitions` repete o arrasto
  inteiro N vezes. Útil pra redimensionar painéis arrastando o divisor.
- `dragFromTo(fromSelector, toSelector, { steps, stepDurationMs })` — mesma coisa, mas até outro
  elemento em vez de um delta calculado.
- `scrollIntoView(selector)` — rola um elemento pra dentro da área visível antes de checar/clicar.
- `scrollBy(deltaX, deltaY, { selector? })` — rola a página (ou um container específico) via wheel
  action de verdade (não `scrollTop` direto — alguns componentes com scroll virtualizado só reagem
  a wheel real). `deltaY` positivo desce, negativo sobe; `deltaX` positivo vai pra direita.
- `withIdleScreenshot(label, fn, idleMs=5000)` — roda `fn()` e tira print automático se não
  resolver em `idleMs` (padrão 5s), ANTES de continuar esperando — não cancela `fn()`, só captura
  o estado da tela no instante em que algo está mais lento que o esperado. Use em qualquer espera
  que pode travar (confirm() nativo, elemento que demora a aparecer) pra sempre sobrar um print do
  momento exato antes de uma possível falha, sem precisar adivinhar onde colocar `snapshot()`.

### `e2e/support/procedures.ts` + `procedures.json` — caminhos já descobertos, salvos

Registro nomeado de sequências de passos (`ProcedureStep[]`) persistido em JSON — grave um
caminho de navegação uma vez, repita depois sem re-derivar:
- `runProcedure(name)` — roda um procedimento salvo.
- `saveProcedure(name, steps)` — grava (ou sobrescreve) um novo. Passos suportados:
  `click`/`type`/`waitText`/`waitTextGone`/`acceptAlert`/`snapshot`/`drag`/`dragTo`/
  `scrollIntoView`/`scrollBy` (mesmos parâmetros das funções equivalentes de `uiKit.ts`).
- `listProcedures()` — lista os nomes já salvos.
- Já vem com `openProjectSettingsAgentsTab`, `openProjectSettingsMergeTab`,
  `closeProjectSettings` pré-gravados (ver `procedures.json`) — expanda essa lista sempre que
  descobrir um caminho novo que valha a pena reusar.

### `e2e/specs/_sandbox.spec.ts` — exploração ad-hoc

Spec descartável, reescrito a cada exploração — não é teste de regressão de nada. Já importa
`quickLogin` + tudo de `uiKit.ts`/`procedures.ts`. Edite o corpo do `it()` livremente.

### `e2e/support/onboardingFlow.ts` — "login"

`quickLogin(displayName)` (= `completeOnboarding`) — passa pela tela de criação de perfil se ela
aparecer; **idempotente**, não trava se o perfil já existir (perfil reaproveitado entre specs).
Chame no início de QUALQUER spec novo, sempre — todo profile e2e nasce vazio.

### `e2e/support/projectUi.ts` — fluxos específicos já mapeados, mais precisos

Prefira estes em vez de `clickByText` solto quando o fluxo já está aqui — mais blindados contra
colisões conhecidas (ex. o mesmo rótulo "OpenCode" existe em telas diferentes):
`createProjectViaUi`, `initGitViaUi`, `selectConflictAgentAndAutoWorktreeViaUi`,
`migrateExistingTerminalsViaUi`, `selectMergePostActionAndSaveViaUi`, `openAgentTerminalViaUi`,
`completeAutoOpenedNewTerminalModal`, `findProjectId`, `findLatestTerminal`,
`getConflictAgentProvider`.

### `e2e/support/ptyAgent.ts` — chamadas de backend diretas (exceção deliberada)

`invokeTauri(cmd, args)` chama comandos Rust direto via `window.__TAURI_INTERNALS__.invoke` — usado
SÓ pra operações que não têm ação de UI equivalente clicável (git/worktree/merge de baixo nível) ou
onde passar pela UI tornaria o teste não-determinístico (ex. resolução de conflito por IA). Nunca
usar isso pra algo que TEM um botão real — aí é `clickByText`/`projectUi.ts`.

## Gotchas reais já diagnosticados (não repita a investigação)

- Diálogo de pasta nativo do Windows (`pickDirectory`) trava o WebDriver — sempre digitar, nunca
  clicar "Procurar".
- `browser.execute()` com uma referência de ELEMENTO como argumento trava ~30s (bug do
  `@wdio/tauri-service`) — `markAndScreenshot` usa `getLocation()`/`getSize()` (comandos nativos)
  e só passa números pro `execute()`, nunca o elemento em si.
- `confirm()`/`alert()` nativos às vezes não registram no primeiro clique — `clickAndAcceptConfirm`
  em `projectUi.ts` já reclica uma vez antes de desistir.
- A aba "Agentes" das Configurações tem DOIS seletores de agente com os MESMOS rótulos (o
  card de "Novo terminal" e o card de "Agente de resolução de conflitos") — sempre confirmar em
  qual modal/aba você está antes de clicar por texto solto.
- **PERIGO REAL**: `[aria-label="Fechar"]` sem escopo bate tanto no botão de fechar um MODAL quanto
  no botão de **fechar a JANELA DO APP INTEIRA** na topbar (mesmo aria-label nos dois!). Um clique
  que "vazasse" pra esse botão fecharia o app de verdade no meio do teste. Confirmado ao vivo
  (só não fechou por sorte — o overlay do modal bloqueou o clique). SEMPRE escopar:
  `$('[role="dialog"] button[aria-label="Fechar"]')` ou `clickByText('Fechar', { scopeSelector:
  '[role="dialog"]' })`, nunca `[aria-label="Fechar"]` solto na página inteira.
- "Iniciar um terminal de agente de verdade (`completeAutoOpenedNewTerminalModal`) ANTES de
  `initGitViaUi()` pode fazer a pasta já virar um repositório Git sozinha — alguns agentes (ex.
  OpenCode) rodam `git init` por conta própria ao subir numa pasta nova. `initGitViaUi()` já lida
  com isso (pula o banner se ele não existir) — não assuma que uma pasta "recém-criada" ainda não
  tem `.git` depois de já ter aberto um terminal de agente real nela.
- Rodar um comando em background (>180s) tira a janela de uma sessão com desktop interativo —
  invisível pro usuário mesmo com o processo vivo. Prefira primeiro plano quando ele quiser ver.
- **Limitação conhecida, ainda sem solução**: clicar numa opção de um menu `Dropdown.tsx`
  (`createPortal` direto em `document.body` — ex. "Local do Controle Git" em Preferências →
  Aparência) pode falhar com `element click intercepted... Other element would receive the click:
  <h2>` no MESMO ponto de pixel, de forma consistente e reprodutível — não é race condition
  (retry com pausa não resolve, testado ao vivo). Provável desalinhamento sistemático entre a
  coordenada que o WebDriver mede e onde o clique realmente aterrissa nesse WebView2 embarcado
  (possível DPI/zoom). Ainda não resolvido — se precisar mudar uma preferência assim, considere
  primeiro achar/usar a API/store direto pra LEITURA de confirmação, ou investigar mais fundo
  antes de assumir que `clickByText` sempre funciona pra esse tipo de menu.

# Testes — backend nativo Ghostty (macOS)

Este documento descreve o fluxo de testes que substitui o ciclo manual de
"subir o app → screenshot → adivinhar" que usávamos para depurar o terminal
nativo. Há três camadas, do mais rápido/determinístico ao mais caro.

## 1. Testes unitários Rust (rápidos, sem GUI)

Conversão de coordenadas web→AppKit e regras puras do bridge. Rodam em qualquer
máquina, em milissegundos.

```sh
npm run test:rust          # cd src-tauri && cargo test --lib
```

Cobre:
- `web_rect_to_appkit_frame` — inversão do eixo Y, clamp de tamanho mínimo.
- (idempotência do spawn é coberta pelo próprio backend + smoke).

## 2. Teste funcional do terminal (headless, libghostty real)

**O mais valioso para depurar "o terminal funciona?".** Cria uma surface real do
Ghostty sem janela visível, digita comandos e lê o grid de volta — provando que
o shell embutido executa `echo`, `cd`/`pwd` e `ls`.

```sh
# Roda os dois testes funcionais: echo/cd/ls e cwd-respeitado.
cd src-tauri && cargo test --lib -- --ignored --test-threads=1 terminal_
# (npm run test:ghostty roda só o terminal_runs)
```

Cobre:
- `terminal_runs_echo_cd_ls` — digita `echo`/`cd`/`ls` e confere a saída no grid.
- `terminal_cwd_respected` — cria a surface com `cwd=/tmp` e confirma que `pwd`
  reporta `/tmp` sem `cd` (prova o repasse de cwd — #5).
- `terminal_renders_continuously` — conta os draws ao longo de 1s rodando só o
  run loop (sem input/sync) e exige ≥20 frames: prova o render contínuo do
  display link/timer (#2). Sem ele, daria 0 (era o estado anterior).

Requer `vendor/GhosttyKit.xcframework` (rode `./src-tauri/vendor/fetch-ghostty.sh`
uma vez). É `#[ignore]` por padrão porque toca AppKit/Metal e exige a main
thread; por isso o `--test-threads=1`.

Se `ghostty_surface_new` retornar NULL, o teste falha com mensagem explícita —
isso já é diagnóstico (ambiente sem contexto gráfico).

## 3. Smoke do app real — prova input→shell→render (substitui o screencapture)

Sobe o app de verdade com `nativeTerminalMacos` ligada e um container aberto, e
roda um **auto-probe** (`ALETHE_GHOSTTY_PROBE=1`): depois de a surface
estabilizar, o backend digita `echo alethe_app_marker_99` na surface real e lê o
grid de volta. O smoke só passa se o echo aparecer (`PROBE echo_visivel=true`) —
ou seja, prova que **o terminal está vivo, aceita input e o shell responde**, no
app real, sem depender de screenshot.

```sh
npm run smoke:ghostty      # bash scripts/smoke-ghostty.sh
```

Saída esperada:
```
[alethe-ghostty] PROBE echo_visivel=true tela: Last login: ... user@host % echo alethe_app_marker_99
✅ smoke OK: terminal Ghostty vivo — echo digitado apareceu na tela (input→shell→render)
```

Falha (exit 1) em: `echo_visivel=false`/`PROBE erro` (input ou render quebrado),
`surface_new FALHOU`/panic, morte do processo, ou timeout (pane não exibido —
ex.: app na Home). O script já prepara o estado (flag + container + limpa a
porta 1422 órfã).

> Por que screenshot não basta (e o probe sim): screenshot depende de foco de
> janela e não distingue "terminal vivo" de "imagem estática". O probe lê o
> conteúdo textual real do grid — é determinístico.

## 4. Testes de frontend (vitest)

Lógica TS pura: detecção de plataforma, regra de seleção de backend (nativo só
no macOS + flag), e coalescing de sincronização.

```sh
npm test                   # vitest run
```

Cobre:
- `isMacOS` por user-agent.
- `shouldUseNativeBackend` — **garante que Windows/Linux nunca caem no nativo**.
- `webRectsEqual` — coalescing que evita IPC redundante em drags.

## Sobre screenshot diff (não incluído)

Avaliamos teste visual por diff de pixels e **decidimos não incluir**: é frágil
(antialias/fontes variam por máquina), lento e exige GUI. O teste funcional (§2)
prova o render de forma muito mais robusta — ele lê o texto real do grid, não
pixels. Se um dia precisarmos de regressão visual, o gancho é o `screencapture`
já usado no desenvolvimento.

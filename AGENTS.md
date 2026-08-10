# Alethe — guia de trabalho (IA)

> Conteúdo idêntico ao [`CLAUDE.md`](CLAUDE.md) deste diretório. Mantenha os dois em sincronia.
> Contribuindo de fora? Comece por [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, layout do
> projeto, regras da casa e convenção de PR.

## 1. O que é

**Alethe** é um app desktop **Windows-first** que organiza, opera e retoma múltiplos agentes de
código (Claude Code, Codex, OpenCode) e shells em paralelo, dentro de uma workspace persistente com
terminais reais (PTYs), layouts, temas, histórico e controle de RAM.

> Tagline: **Reveal the state of every agent, shell, and project.**
> Status: **v1.3.0**, MVP funcional em polish. Identifier: `com.kc1t.alethe`.

## 2. Onde você está

Na raiz do repositório — o diretório do app. Aqui ficam:

- `src/` — frontend React.
- `src-tauri/` — backend Rust/Tauri.
- `docs/` — docs versionados (`FEATURES.md`, `CHANGELOG.md`, `OVERVIEW.md`, `BRAND.md`,
  `DIAGNOSTICO_MATURIDADE_TECNICA.md`).
- `package.json`, `vite.config.ts`, `tsconfig.json`, `tests/`.

## 3. Stack

- **Frontend:** React 18.3 · TypeScript 5.6 · Vite 6 · Zustand 5 · xterm.js 5.5 (`@xterm/addon-fit`, `-search`, `-webgl`) · `react-resizable-panels` · `@dnd-kit/core` · `@radix-ui/react-dialog` · `lucide-react` · `nanoid`.
- **Backend:** Rust (edition 2021) · Tauri 2 · `portable-pty` (ConPTY no Windows) · `tokio` · `reqwest` · `keyring` · `serde`.
- **Estilo:** CSS Modules + CSS custom properties (sem Tailwind, sem styled-components).

## 4. Comandos (de `package.json`)

```powershell
npm install
npm run app      # = tauri dev — roda o app completo com hot reload (FORMA RECOMENDADA)
npm run dev      # só o frontend Vite em http://localhost:1422 (strictPort)
npm run build    # tsc + vite build — o tsc faz typecheck e VALIDA o i18n (ver §5)
npm test         # vitest run sobre tests/**/*.test.ts (test:node roda via node --test, à parte)
```

**Build do instalador Windows (MSI/NSIS)** precisa do ambiente MSVC (`vcvars64`):

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >NUL && npm run tauri build'
```

Ao retornar o caminho de um instalador gerado, informe sempre o **caminho absoluto completo no PC**
(por exemplo, `D:\projeto\src-tauri\target\release\bundle\nsis\Alethe_setup.exe`), nunca apenas o
caminho relativo ao repositório.

Detalhes em `docs/BUILD_WINDOWS.md` (não versionado neste repo — só na máquina do dono).

## 5. Regras inegociáveis

1. **NÃO encerre nem reinicie o app nem o dev server** (`tauri dev` / Vite). Não mate o processo,
   não rode `npm run app` "pra testar" se já estiver rodando. Aplique mudanças via **HMR** e confie no reload.
2. **NÃO faça commit / push / tag / release sem permissão explícita do dono na hora.** Faça as
   alterações **só no working tree** e pare — quem decide commitar é ele. Quando ele autorizar um
   commit, **NÃO adicione co-autor** (`Co-Authored-By: Claude …`) nem qualquer assinatura de
   ferramenta na mensagem — o autor é só ele.
3. **Design system estrito — sem gradientes, sem "vibecoded".** Nada de UI genérica de template.
   Dashboards e widgets mostram **dado real**, nunca placeholder/mock. Estilo via CSS Modules +
   tokens de `src/styles/theme.css`; **nunca** hardcode de cor — use as variáveis (`--bg`, `--fg`,
   `--accent`, `--agent-*`, `--status-*`, etc.).
4. **i18n obrigatório.** Toda string visível passa por `t()`. Ao adicionar texto, registre a chave
   em `src/lib/i18n/messages/en.ts` (**fonte da verdade**, default EN) **e** em
   `src/lib/i18n/messages/pt-BR.ts`. O `pt-BR.ts` é tipado contra as chaves de `en.ts`, então
   `npm run build` **falha** se faltar tradução.
5. **Changelog obrigatório para features.** Toda adição, alteração ou remoção de feature deve
   atualizar [`docs/CHANGELOG.md`](docs/CHANGELOG.md) na mesma tarefa, sob a seção
   **`[Não lançado]`** (topo do arquivo), com uma descrição curta, objetiva e voltada ao
   usuário. Nunca pule esse passo — o changelog é a fonte das notas de release.

## 6. Arquitetura rápida

**Frontend (`src/`)**
- `components/` — UI por feature (`HomeView/`, `WorkspaceView/`, `XTermView/`, `ProjectSidebar/`, `TitleBar/`, `modals/`…). 1 `.module.css` por componente.
- `stores/` — Zustand: `projectsStore` (projetos/grupos/terminais/preferences, **persistido** em `projects.json`) e `uiStore` (modais/toasts/efêmero).
- `lib/tauri/` — wrapper de `invoke`, dividido por domínio (`git`, `pty`, `agents`, `usage`…), com `index.ts` reexportando tudo — call-sites continuam importando de `lib/tauri` sem mudança.
- `lib/i18n/` — sistema de i18n (`index.ts` + `messages/en.ts` + `messages/pt-BR.ts`).
- `lib/types.ts` — tipos do domínio (`AgentType`, `Terminal`, `Project`, `Group`, `GridLayout`…).
- `styles/theme.css` + `styles/reset.css` — tokens e reset.

**Backend (`src-tauri/src/`)**
- `lib.rs` — `invoke_handler` (registro de todos os `#[tauri::command]`).
- `pty.rs` — spawn/attach/write/resize/restart/kill de PTYs + scrollback em disco.
- `projects.rs` — load/save atômico de `projects.json`. `profiles` — multi-perfil isolado.
- `cli_resolver.rs` — descobre CLIs (pwsh/powershell, Node managers, VS Code) no Windows.
- `claude_sessions.rs` / `codex_sessions.rs` / `claude_usage.rs` — leitura de sessões e uso.
- `spotify.rs`, `backup.rs`, `diagnostics.rs`, `agent_library.rs`, `agent_events.rs`, `stats.rs`.

**Comunicação:** frontend chama `invoke(...)` via `lib/tauri/`; o terminal recebe streaming por
eventos Tauri `pty://data/{id}` e `pty://exit/{id}`.

## 7. Convenções

- 1 arquivo `.module.css` por componente; cor/spacing sempre via tokens, nunca literal.
- Tipos novos do domínio em `src/lib/types.ts`; reúse os existentes.
- Selectors Zustand enxutos para evitar loops de rerender; `projects.json` salva com debounce e
  escrita atômica (tmp → rename) — preserve esse padrão.
- Schema de `projects.json` é versionado com migração/backfill — ao mudar shape, mantenha a migração.

## 8. Gotchas / segurança

- `csp: null` em `tauri.conf.json` → o webview tem acesso total ao IPC. Trate qualquer entrada
  renderizada como não-confiável.
- `spawn_pty` executa shell com comando/args vindos do frontend — **valide entrada no front** antes de spawnar.
- Tokens OAuth (Spotify, Claude) ficam em **plaintext** no app data; não logue nem exponha.
- Build Windows exige `vcvars64`. A toolchain Rust em `C:` pode ser corrompida pelo Windows Defender
  — preferir buildar de `D:`.
- Dados locais: `%APPDATA%/Alethe/` (perfis, `projects.json`, scrollback `*.bin`, `spawn.log`).

## 9. Aprofundar

Versionado neste repo:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup por SO, layout, regras da casa, convenção de commit/PR.
- [`docs/FEATURES.md`](docs/FEATURES.md) — features em detalhe.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — histórico voltado ao usuário.
- [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — modelo de domínio (Grupo, Projeto, Container, Pane,
  Terminal, Sub-tab, PTY), stack e persistência.
- [`docs/BRAND.md`](docs/BRAND.md).
- [`docs/DIAGNOSTICO_MATURIDADE_TECNICA.md`](docs/DIAGNOSTICO_MATURIDADE_TECNICA.md) — diagnóstico
  de organização, duplicação e performance do código, com recomendações priorizadas.

Só na máquina do dono (não versionado): `CODE_STANDARDS.md`, `GLOSSARY.md`, `CONTEXTO_IA.md`,
`HANDOFF_STATUS.md`, `CURRENT_STEP.md`. O glossário do domínio (Grupo, Projeto, Container, Pane,
Sub-tab, PTY) está resumido no `CONTRIBUTING.md`.

## graphify

## Language and comment rules

- English is the default language for all versioned repository content, including source comments,
  JSDoc, documentation, changelog entries, user-facing strings, commit messages, and pull requests.
- Use another language only when the target file explicitly requires it. Locale files are the standard
  exception: translated UI text belongs in the matching locale file.
- When editing existing mixed-language content, translate the touched content to English when practical
  instead of extending the language inconsistency.
- Keep comments concise. Add them only when they explain non-obvious behavior, constraints, or decisions.

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Universal across the 3 agent providers Alethe spawns (Claude Code, Codex, OpenCode) when the project has Graphify enabled: each gets the Graphify MCP server wired into its session automatically (Claude via `--mcp-config`; Codex/OpenCode via `.codex/config.toml`/`opencode.json` in the project root — see `graphify_codex_config_write`/`graphify_opencode_config_write` in `src-tauri/src/graphify.rs`).

Rules:
- If a Graphify MCP tool (e.g. `graphify_query`/similar) is available in this session, prefer calling it directly over shelling out — same scoped-subgraph result, no extra process spawn.
- Otherwise, for codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

# Backlog de Execução Alethe (Modo Web & Desktop) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar o backlog de correções de estabilidade do modo Web, paridade desktop/web, novas ferramentas MCP nativas (planejamento padronizado e automação de browser), painéis da UI e melhorias de segurança.

**Architecture:** Rust (backend Axum + Tauri IPC + stdio MCP servers) + React/TypeScript (frontend Zustand + CSS Modules + Webview child + XTerm).

**Tech Stack:** Rust (axum, tauri, tokio, serde), React 18, TypeScript, Zustand 5, xterm.js.

---

### Task 1: [Item #9] Visibilidade da Central de Merges no Sidebar
**Files:**
- Modify: `src/components/ProjectSidebar/index.tsx`
- Test: `npm test`

- [ ] **Step 1: Condicionar renderização do SidebarMergePanel à aba de projetos**
Em `src/components/ProjectSidebar/index.tsx`, envolver `<SidebarMergePanel />` para renderizar apenas quando `sidebarTab === 'projects'` e `activeView === 'workspace'`.
- [ ] **Step 2: Validar visualmente e rodar testes unitários**
Run: `npm test`
Expected: PASS

---

### Task 2: [Item #1 & #10] Estabilidade do `alethe-server` e Graceful Degradation
**Files:**
- Modify: `src-tauri/src/server_main/mod.rs`
- Modify: `src-tauri/src/server_main/fs_cli_routes.rs`
- Modify: `src-tauri/src/server_main/misc_routes.rs`
- Test: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

- [ ] **Step 1: Adicionar Middleware de CatchPanic e tratamentos de rota no axum**
Garantir que chamadas a rotas sem suporte retornem status 501/JSON estruturado em vez de derrubar o processo com panic.
- [ ] **Step 2: Prevenir lock de porta TCP 10048 no encerramento**
Ajustar socket bind com `SO_REUSEADDR` / shutdown limpo do listener.
- [ ] **Step 3: Testar compilação e testes do backend**
Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS

---

### Task 3: [Item #3 & #4] Paridade Web: Leitura de Markdown e Sincronização de Resize
**Files:**
- Modify: `src/components/MarkdownPane/index.tsx`
- Modify: `src/stores/projectsStore.ts`
- Modify: `src/lib/api/transport.ts`
- Test: `npm test`

- [ ] **Step 1: Adaptar leitura de arquivos no MarkdownPane para rotas HTTP do alethe-server**
- [ ] **Step 2: Persistir alterações de layout do react-resizable-panels via API HTTP**
- [ ] **Step 3: Validar com testes unitários**
Run: `npx vitest run src/lib/api/transport.test.ts`
Expected: PASS

---

### Task 4: [Item #8] Colagem de Imagens nos Terminais (Claude Code, Codex, Antigravity)
**Files:**
- Modify: `src/components/XTermView/useXtermSession.ts`
- Modify: `src/components/XTermView/terminalInput.ts`
- Modify: `src/lib/tauri/diagnostics.ts`
- Test: `npm test`

- [ ] **Step 1: Interceptar evento de paste no xterm.js quando houver imagem no clipboard**
Salvar a imagem temporariamente via backend e colar o caminho absoluto (`"C:\Users\...\AppData\Local\Temp\alethe-img-...png"`) no stdin da PTY.
- [ ] **Step 2: Preservar o comportamento nativo existente do OpenCode**
- [ ] **Step 3: Testar com vitest**
Run: `npx vitest run src/components/XTermView/terminalInput.test.ts`
Expected: PASS

---

### Task 5: [Item #5] Servidor MCP de Planejamento Padronizado
**Files:**
- Create: `src-tauri/src/planning.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/opencode_bridge.rs`
- Modify: `src-tauri/src/cli_launch.rs`
- Test: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

- [ ] **Step 1: Criar módulo Rust stdio MCP para geração de planos com seções estruturadas**
Salvar em `.alethe/plans/<projeto>/<terminal-id>/<timestamp>.md`.
- [ ] **Step 2: Injetar MCP no spawn de Claude Code, Codex e OpenCode**
- [ ] **Step 3: Adicionar prompt customizado de personalidade para o modo plan do OpenCode**
- [ ] **Step 4: Validar testes do Rust**
Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS

---

### Task 6: [Item #6] Lista de Planos na Barra Lateral Direita
**Files:**
- Create: `src/components/PlansSidebarPanel/index.tsx`
- Create: `src/components/PlansSidebarPanel/PlansSidebarPanel.module.css`
- Modify: `src/components/WorkspaceView/index.tsx`
- Test: `npm test`

- [ ] **Step 1: Criar painel lateral direito listando planos agrupados por projeto e terminal**
- [ ] **Step 2: Conectar clique no plano para abrir no visualizador de Markdown**
- [ ] **Step 3: Testes de renderização**
Run: `npm test`
Expected: PASS

---

### Task 7: [Item #7] MCP de Automação de Browser para o WebPane
**Files:**
- Create: `src-tauri/src/browser_mcp.rs`
- Modify: `src/components/WebPane/PrivateBrowserSurface.tsx`
- Test: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

- [ ] **Step 1: Criar MCP tools: `browser_navigate`, `browser_click`, `browser_type`, `browser_get_console_logs`, `browser_take_screenshot`**
- [ ] **Step 2: Integrar comandos com o child Webview do Tauri**
- [ ] **Step 3: Testar compilação**
Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS

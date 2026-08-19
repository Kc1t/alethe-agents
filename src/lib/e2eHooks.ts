import {
  gitInit,
  gitStatus,
  mergeAnalyze,
  mergeFinalize,
  mergePrepare,
  mergeValidate,
  worktreeProvision,
  worktreeRemove,
  type MergeAnalysis,
  type MergeOutcome,
  type ConflictEnv,
  type WorktreeInfo,
} from './api/git'
import { attachPty, getPtySize, killPty, ptyExists, resizePty, spawnPty, writePty } from './api/pty'
import { useProjectsStore } from '../stores/projectsStore'

/**
 * Hook de instrumentação só pra e2e (Central de Merges — Partes 4/5).
 *
 * Pedido explícito, depois de confirmar ao vivo que `browser.tauri.execute`
 * (a ponte específica de Tauri do `@wdio/tauri-service`) não funciona nesse
 * ambiente (`Tauri core.invoke not available after 5s timeout` — bug/
 * incompatibilidade da própria lib no modo "embedded"): bater direto no
 * backend via `fetch()` a partir do Node contornaria isso, mas testaria só
 * o BACKEND — nada garante que o FRONTEND de verdade chama esses comandos
 * do jeito certo (é exatamente esse tipo de bug, só no frontend, que a
 * Parte 1 desta sessão corrigiu). `browser.execute()` PADRÃO (não
 * `.tauri.execute()`) foi confirmado funcionando — alcança o JS real da
 * página. Este arquivo expõe, em `window`, chamadas finas que só REPASSAM
 * pras funções REAIS de `src/lib/api/*` (as mesmas que `useXtermSession.ts`,
 * `EditProjectModal.tsx` etc. chamam) — o teste então exercita o mesmo
 * `isTauriEnv()`/`canUseSharedCoreTransport()` que decide IPC vs HTTP de
 * verdade, em vez de simular ou contornar.
 *
 * Somente leitura/criação local de estado do app — nenhuma entrada externa
 * não confiável é processada aqui além dos parâmetros que o próprio teste
 * escolhe (pastas/comandos que ele mesmo criou). Sempre presente (o build
 * de e2e usa `vite build` normal, sem `import.meta.env.DEV`, então não dá
 * pra gatear por isso em runtime) — mesmo raciocínio do hook de debug de
 * terminal em `useXtermSession.ts`.
 */
declare global {
  interface Window {
    /** Só LEITURA — nunca executa nenhuma ação. Usado por specs 100%
     *  orientados a clique/digitação (ex. `onboarding.spec.ts`) pra
     *  verificar que uma interação real da UI persistiu de verdade no
     *  store, sem precisar de outro hook de ação pra isso. */
    __ALETHE_E2E_STORE_DEBUG__?: () => {
      displayName: string
      language: string
      onboardingDone: boolean
    }
    /** Só LEITURA — nunca cria/dispara nada. Cliques reais na UI (criar
     *  projeto, abrir terminal) não devolvem IDs pro teste; isso só
     *  localiza o que a UI já criou de verdade, pra continuar verificando
     *  (ex. ler o ptyId de um terminal aberto via clique, pra inspecionar
     *  o scrollback dele). */
    __ALETHE_E2E_QUERY__?: {
      findProjectIdByName: (name: string) => string | null
      /** Devolve o terminal mais recente do projeto (último criado) — é o
       *  que uma sequência de cliques reais acabou de abrir, sem precisar
       *  saber de antemão o id de worktree que a UI gerou sozinha. */
      findLatestTerminal: (
        projectId: string,
      ) => { ptyId: string; worktreeAgentId: string | null } | null
      /** Confirma qual agente de resolução de conflitos está de fato salvo
       *  no projeto — o card correspondente não tem `aria-pressed` (só um
       *  ícone `CircleCheck` condicional, não checável sem depender de
       *  classe CSS hasheada), então a única verificação confiável é ler o
       *  valor real persistido no store. */
      getConflictAgentProvider: (projectId: string) => string | null
      /** Devolve o id do projeto ativo — útil quando o projeto foi criado
       *  por um atalho (ex. `RecorderHelper`) com nome gerado em runtime
       *  (`recorder-<timestamp>`) que o teste não conhece de antemão. */
      getActiveProjectId: () => string | null
      /** Devolve o `worktreePath` real do terminal (não só o `ptyId`/
       *  `worktreeAgentId` que `findLatestTerminal` já expõe) — precisa pra
       *  escrever um arquivo determinístico direto na worktree, contornando
       *  um agente de IA real, em diagnósticos isolados de merge. */
      getTerminalWorktreePath: (projectId: string, terminalId: string) => string | null
    }
    __ALETHE_E2E__?: {
      openShellTerminal: (
        cwd: string,
      ) => Promise<{ projectId: string; terminalId: string; ptyId: string }>
      waitForSyncedProjectAndFocus: (
        projectId: string,
        timeoutMs?: number,
      ) => Promise<{ terminalId: string; ptyId: string }>
      setLanguage: (locale: 'en' | 'pt-BR') => void
      pty: {
        spawn: (cwd: string, command?: string, cols?: number, rows?: number) => Promise<string>
        write: (id: string, data: string) => Promise<void>
        readScrollback: (id: string, maxBytes?: number) => Promise<string>
        exists: (id: string) => Promise<boolean>
        getSize: (id: string) => Promise<{ cols: number; rows: number }>
        resize: (id: string, cols: number, rows: number) => Promise<void>
        kill: (id: string) => Promise<void>
      }
      git: {
        status: (path: string) => ReturnType<typeof gitStatus>
        init: (path: string) => ReturnType<typeof gitInit>
        worktreeProvision: (repo: string, agentId: string) => Promise<WorktreeInfo>
        worktreeRemove: (repo: string, agentId: string) => Promise<void>
        mergeAnalyze: (repo: string, source: string, target: string) => Promise<MergeAnalysis>
        mergePrepare: (repo: string, source: string, target: string) => Promise<ConflictEnv>
        mergeValidate: (
          repo: string,
          envId: string,
          validationCommands: string[],
        ) => Promise<MergeOutcome>
        mergeFinalize: (
          repo: string,
          envId: string,
          validationCommands: string[],
          healthCheckCommand?: string,
          healthCheckPath?: string,
        ) => Promise<MergeOutcome>
      }
    }
  }
}

const DEFAULT_PROFILE_ID = 'default'

function waitForPtyId(projectId: string, terminalId: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const terminal = project?.terminals.find((t) => t.id === terminalId)
      const ptyId = terminal?.tabs[0]?.ptyId
      if (ptyId) {
        resolve(ptyId)
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('__ALETHE_E2E__.openShellTerminal: timeout esperando o ptyId aparecer'))
        return
      }
      window.setTimeout(check, 300)
    }
    check()
  })
}

export function installE2eHooks(): void {
  if (typeof window === 'undefined') return
  window.__ALETHE_E2E_STORE_DEBUG__ = () => {
    const { preferences } = useProjectsStore.getState()
    return {
      displayName: preferences.displayName,
      language: preferences.language,
      onboardingDone: preferences.onboardingDone,
    }
  }
  window.__ALETHE_E2E_QUERY__ = {
    findProjectIdByName: (name: string) => {
      const project = useProjectsStore.getState().projects.find((p) => p.name === name)
      return project?.id ?? null
    },
    findLatestTerminal: (projectId: string) => {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const terminal = project?.terminals[project.terminals.length - 1]
      const ptyId = terminal?.tabs[0]?.ptyId
      if (!terminal || !ptyId) return null
      return { ptyId, worktreeAgentId: terminal.worktreeAgentId ?? null }
    },
    getConflictAgentProvider: (projectId: string) => {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      return project?.conflictAgentProvider ?? null
    },
    getActiveProjectId: () => useProjectsStore.getState().activeProjectId ?? null,
    getTerminalWorktreePath: (projectId: string, terminalId: string) => {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const terminal = project?.terminals.find((t) => t.id === terminalId)
      const tab = terminal?.tabs.find((t) => t.id === terminal.activeTabId) ?? terminal?.tabs[0]
      return tab?.cwd ?? terminal?.cwd ?? null
    },
  }
  window.__ALETHE_E2E__ = {
    openShellTerminal: async (cwd: string) => {
      const project = useProjectsStore.getState().createProject({
        name: `e2e-${Date.now()}`,
        defaultCwd: cwd,
      })
      const terminal = useProjectsStore.getState().createTerminal(project.id, {
        name: 'e2e-shell',
        cwd,
        firstTab: { type: 'shell', cwd },
      })
      await useProjectsStore.getState().flushPersistence()
      const ptyId = await waitForPtyId(project.id, terminal.id)
      return { projectId: project.id, terminalId: terminal.id, ptyId }
    },
    waitForSyncedProjectAndFocus: async (projectId: string, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      let project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      while (!project && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 300))
        project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      }
      if (!project) {
        throw new Error(
          `__ALETHE_E2E__.waitForSyncedProjectAndFocus: projeto ${projectId} nunca sincronizou`,
        )
      }
      useProjectsStore.setState({ activeProjectId: projectId })
      const terminal = project.terminals[0]
      if (!terminal) {
        throw new Error(
          `__ALETHE_E2E__.waitForSyncedProjectAndFocus: projeto ${projectId} sincronizou sem terminal`,
        )
      }
      const ptyId = await waitForPtyId(projectId, terminal.id, timeoutMs)
      return { terminalId: terminal.id, ptyId }
    },
    setLanguage: (locale: 'en' | 'pt-BR') => {
      useProjectsStore.getState().setLanguage(locale)
    },
    pty: {
      spawn: async (cwd, command, cols = 80, rows = 24) => {
        const res = await spawnPty({ cwd, command, cols, rows, profileId: DEFAULT_PROFILE_ID })
        return res.id
      },
      write: (id, data) => writePty(id, data, DEFAULT_PROFILE_ID),
      readScrollback: (id, maxBytes) =>
        attachPty(id, typeof maxBytes === 'number' ? maxBytes : 65536, DEFAULT_PROFILE_ID),
      exists: (id) => ptyExists(id, DEFAULT_PROFILE_ID),
      getSize: (id) => getPtySize(id, DEFAULT_PROFILE_ID),
      resize: (id, cols, rows) => resizePty(id, cols, rows, DEFAULT_PROFILE_ID),
      kill: (id) => killPty(id, DEFAULT_PROFILE_ID),
    },
    git: {
      status: (path) => gitStatus(path),
      init: (path) => gitInit(path),
      worktreeProvision: (repo, agentId) => worktreeProvision(repo, agentId, 'gitWorktree'),
      worktreeRemove: (repo, agentId) => worktreeRemove(repo, agentId, true),
      mergeAnalyze: (repo, source, target) => mergeAnalyze(repo, source, target),
      mergePrepare: (repo, source, target) => mergePrepare(repo, source, target),
      mergeValidate: (repo, envId, validationCommands) =>
        mergeValidate(repo, envId, validationCommands),
      mergeFinalize: (repo, envId, validationCommands, healthCheckCommand, healthCheckPath) =>
        mergeFinalize(repo, envId, validationCommands, healthCheckCommand, healthCheckPath),
    },
  }
}

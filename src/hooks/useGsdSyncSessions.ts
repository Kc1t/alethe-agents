import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'

import { readGsdChildBusy, readGsdChildError, readGsdChildSession } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

export type GsdSyncSession = {
  id: string
  projectId: string
  /** Pasta da worktree onde a sessão-filha roda — usada direto como fonte de
   *  dados (`opencode export`), sem nenhum terminal PTY no meio. */
  worktreePath: string
  childId: string
  busy: boolean
  hasError: boolean
}

type WatchedItem = {
  id: string
  projectId: string
  worktreePath: string
}

// Store minúsculo, só pra ter UM único poll de verdade no app inteiro
// (SidebarMergePanel E a gaveta GSD Sync mostram os mesmos dados). Sem isso,
// cada `useEffect` chamando o hook rodaria seu próprio poll de 5s.
const useGsdSyncSessionsStore = create<{ sessions: GsdSyncSession[] }>(() => ({ sessions: [] }))

/**
 * Único responsável por rodar o poll de verdade (leitura de
 * `.planning/.gsd-child-session` / `.gsd-child-busy` / `.gsd-child-error` a
 * cada 5s). Deve ser chamado em exatamente UM lugar montado sempre (hoje:
 * `SidebarMergePanel`, montado incondicionalmente na Sidebar de Projetos).
 *
 * Não cria nenhum terminal/PTY — a sessão-filha roda dentro do processo
 * OpenCode do terminal PRINCIPAL (mecanismo interno de multi-sessão do
 * próprio OpenCode via o plugin `alethe-gsd-state.ts`), então não depende de
 * nenhum terminal "viewer" pra existir. A visualização (gaveta GSD Sync) lê o
 * conteúdo direto via `opencode export <childId>` (`GsdSyncActivityView`) —
 * um `<div>` HTML somente-leitura, sem terminal PTY nenhum no caminho.
 */
export function useGsdSyncSessionsWatcher(
  onChildError?: (session: { projectId: string; worktreePath: string }, message: string) => void,
): void {
  const projects = useProjectsStore((s) => s.projects)

  const pollingRef = useRef<Set<string>>(new Set())
  const onChildErrorRef = useRef(onChildError)
  onChildErrorRef.current = onChildError

  // Mesmo critério de `XTermView` pra escrever o plugin GSD (comando opencode
  // + cwd + watcher ligado no projeto) — sem exigir isolamento de worktree.
  const watched: WatchedItem[] = useMemo(() => {
    const result: WatchedItem[] = []
    for (const proj of projects) {
      if (!proj.gsdWatcherEnabled) continue
      for (const term of proj.terminals) {
        // Agente efêmero de resolução de conflito nunca é rastreável aqui —
        // o plugin GSD nem é instalado nele (ver TerminalPane).
        if (term.ephemeralConflictAgent) continue
        if (term.cwd && term.tabs.some((tab) => tab.type === 'opencode')) {
          result.push({ id: `${proj.id}-${term.id}`, projectId: proj.id, worktreePath: term.cwd })
        }
      }
    }
    return result
  }, [projects])

  useEffect(() => {
    if (watched.length === 0) {
      useGsdSyncSessionsStore.setState({ sessions: [] })
      return
    }

    const poll = async () => {
      // Lido fresco a cada tick (não como dependência do efeito) pelo mesmo
      // motivo de sempre: evitar reagendar o poll a cada mutação de estado.
      const { projects } = useProjectsStore.getState()
      const next: GsdSyncSession[] = []
      // Ids que este poll de fato resolveu (sessão encontrada OU
      // comprovadamente ausente) — usado pra decidir o que remover do store
      // compartilhado sem apagar entradas de itens que outro poll sobreposto
      // ainda está processando.
      const resolvedIds = new Set<string>()
      for (const item of watched) {
        // Guard síncrono antes de qualquer await — evita reentrância quando
        // dois `poll()` se sobrepõem.
        if (pollingRef.current.has(item.id)) continue
        pollingRef.current.add(item.id)
        try {
          const childId = await readGsdChildSession(item.worktreePath).catch(() => null)
          if (!childId) {
            resolvedIds.add(item.id)
            continue
          }
          const proj = projects.find((p) => p.id === item.projectId)
          if (!proj) {
            resolvedIds.add(item.id)
            continue
          }

          const busy = await readGsdChildBusy(item.worktreePath).catch(() => false)
          const childError = await readGsdChildError(item.worktreePath).catch(() => null)
          if (childError) {
            onChildErrorRef.current?.(
              { projectId: item.projectId, worktreePath: item.worktreePath },
              childError,
            )
          }

          resolvedIds.add(item.id)
          next.push({
            id: item.id,
            projectId: item.projectId,
            worktreePath: item.worktreePath,
            childId,
            busy,
            hasError: Boolean(childError),
          })
        } catch (error) {
          // Sem isso, uma falha escapava do loop inteiro como rejeição não
          // tratada — abortava o resto de `watched` NESTE tick, não só este
          // item. Não marca `resolvedIds` pra este item: tenta de novo
          // sozinho no próximo tick de 5s.
          console.error(`[gsd-sync] falha processando ${item.id}:`, error)
        } finally {
          pollingRef.current.delete(item.id)
        }
      }
      // Merge por id em vez de substituição total: preserva entradas de itens
      // que um poll SOBREPOSTO ainda está processando, atualiza/remove só o
      // que este poll de fato resolveu, e descarta qualquer entrada cuja
      // worktree já não existe mais em `watched`.
      useGsdSyncSessionsStore.setState((state) => {
        const byId = new Map(state.sessions.map((session) => [session.id, session]))
        for (const session of next) byId.set(session.id, session)
        for (const id of resolvedIds) {
          if (!next.some((session) => session.id === id)) byId.delete(id)
        }
        const watchedIds = new Set(watched.map((item) => item.id))
        return { sessions: [...byId.values()].filter((session) => watchedIds.has(session.id)) }
      })
    }

    void poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [watched])
}

                                                                             
                                                                            
                                                            
export function useGsdSyncSessions(): GsdSyncSession[] {
  return useGsdSyncSessionsStore((s) => s.sessions)
}

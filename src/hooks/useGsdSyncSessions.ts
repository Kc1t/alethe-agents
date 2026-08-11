import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'

import { useT } from '../lib/i18n'
import { readGsdChildBusy, readGsdChildError, readGsdChildSession } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

export type GsdSyncSession = {
  id: string
  projectId: string
  /** Terminal "viewer" da sessão-filha — sempre existe (achado ou criado sob demanda). */
  terminalId: string
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
// cada `useEffect` chamando o hook rodaria seu próprio poll de 5s e os dois
// "achar-ou-criar terminal viewer" correriam em paralelo — a mesma corrida de
// pane duplicada já corrigida nesta sessão, só que entre dois componentes em
// vez de duas invocações do mesmo efeito.
const useGsdSyncSessionsStore = create<{ sessions: GsdSyncSession[] }>(() => ({ sessions: [] }))

/**
 * Único responsável por rodar o poll de verdade (leitura de
 * `.planning/.gsd-child-session` / `.gsd-child-busy` / `.gsd-child-error` a
 * cada 5s, achar-ou-criar o terminal "viewer" sob demanda). Deve ser chamado
 * em exatamente UM lugar montado sempre (hoje: `SidebarMergePanel`, montado
 * incondicionalmente na Sidebar de Projetos). O terminal "viewer" NUNCA é
 * inserido em `paneIds` aqui — só existe pra ter um `Terminal.id` estável pra
 * resumir `opencode --session <childId>` quando o usuário pedir explicitamente
 * pela gaveta GSD Sync.
 */
export function useGsdSyncSessionsWatcher(
  onChildError?: (session: { projectId: string; terminalId: string }, message: string) => void,
): void {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const createTerminal = useProjectsStore((s) => s.createTerminal)
  const setSubTabSessionId = useProjectsStore((s) => s.setSubTabSessionId)
  const closePane = useProjectsStore((s) => s.closePane)
  const markGsdSyncViewer = useProjectsStore((s) => s.markGsdSyncViewer)

  const pollingRef = useRef<Set<string>>(new Set())
  const onChildErrorRef = useRef(onChildError)
  onChildErrorRef.current = onChildError
  // `t` muda de referência a cada render (useT novo toda vez) — se entrasse
  // na dependência do efeito abaixo, causaria o mesmo re-trigger espúrio que
  // `projects`/`containers` causavam (ver comentário no useEffect).
  const tRef = useRef(t)
  tRef.current = t

  // Mesmo critério de `XTermView` pra escrever o plugin GSD (comando opencode
  // + cwd + watcher ligado no projeto) — sem exigir isolamento de worktree.
  // Antes disso exigia `term.worktreeAgentId && term.cwd !== repo`, então um
  // terminal OpenCode SEM isolamento tinha o plugin instalado e podia gerar
  // uma sessão-filha de verdade em disco, mas nunca entrava aqui — a seção
  // GSD Sync nunca aparecia pra esse caso, mesmo com tudo funcionando.
  //
  // `!term.gsdSyncViewer` é essencial: o terminal "viewer" que este próprio
  // hook cria abaixo (`createTerminal(..., { firstTab: { type: 'opencode',
  // cwd: item.worktreePath }, gsdSyncViewer: true })`) também bate no
  // critério acima (mesmo cwd, tab tipo opencode) — sem excluí-lo, cada
  // viewer virava sua PRÓPRIA entrada em `watched`, apontando pro mesmo
  // `.planning/.gsd-child-session`, e o poll seguinte podia não achar esse
  // viewer via `sessionId` a tempo e criar OUTRO viewer pro mesmo item —
  // corrida que duplicava a sessão na UI e podia travar o spawn em loop.
  const watched: WatchedItem[] = useMemo(() => {
    const result: WatchedItem[] = []
    for (const proj of projects) {
      if (!proj.gsdWatcherEnabled) continue
      for (const term of proj.terminals) {
        if (!term.gsdSyncViewer && term.cwd && term.tabs.some((tab) => tab.type === 'opencode')) {
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
      // Lido fresco a cada tick (não como dependência do efeito) — o próprio
      // corpo do poll muda `projects`/`containers` (createTerminal/closePane/
      // markGsdSyncViewer). Se esses valores fossem dependência do efeito,
      // cada mutação derrubava e reagendava o poll (novo `poll()` disparado
      // na hora) ENQUANTO o poll anterior ainda estava no meio do `await` de
      // outro item — dois `poll()` sobrepostos se substituíam um ao outro no
      // estado compartilhado (`setState` de troca total), cada um com uma
      // worktree faltando. Era exatamente o "duas sessões brigando por um
      // espaço" relatado com duas worktrees novas ao mesmo tempo.
      const { projects, workspace } = useProjectsStore.getState()
      const containers = workspace.containers
      const t = tRef.current
      const next: GsdSyncSession[] = []
      // Ids que este poll de fato resolveu (sessão encontrada OU
      // comprovadamente ausente) — usado pra decidir o que remover do store
      // compartilhado sem apagar entradas de itens que outro poll sobreposto
      // ainda está processando (esses só têm o `continue` de reentrância
      // abaixo, nunca entram aqui).
      const resolvedIds = new Set<string>()
      for (const item of watched) {
        // Guard síncrono antes de qualquer await — evita reentrância quando
        // dois `poll()` se sobrepõem (ver comentário acima). Item ainda em
        // progresso por outro poll: pula sem tocar na entrada dele no store.
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
          let terminalId: string | null = null
          for (const term of proj.terminals) {
            if (term.tabs.some((tab) => tab.sessionId === childId)) {
              terminalId = term.id
              break
            }
          }
          if (!terminalId) {
            const created = await createTerminal(item.projectId, {
              name: t('merge.gsdSyncPaneName'),
              cwd: item.worktreePath,
              firstTab: { type: 'opencode', cwd: item.worktreePath },
              gsdSyncViewer: true,
            })
            setSubTabSessionId(item.projectId, created.id, created.activeTabId, childId)
            // createTerminal insere o terminal novo em paneIds por padrão
            // (comportamento certo pros outros ~15 call sites que usam ela,
            // que sempre querem o terminal novo visível na hora). Aqui é o
            // oposto: esse terminal é só um "viewer" pra sessão-filha, nunca
            // deve aparecer sozinho na grade normal — desfaz o auto-open na
            // hora, antes de qualquer render mostrar ele lá.
            closePane(item.projectId, created.id)
            terminalId = created.id
          } else {
            // Mesma garantia acima, mas pro caso do terminal "viewer" já
            // existir e (por qualquer motivo — leftover de antes desse
            // comportamento existir, ou algum outro caminho) estar aberto na
            // grade normal. A gaveta GSD Sync é o único jeito válido de ver
            // essa pane; se ela aparecer sozinha na grade, fecha de novo.
            const container = containers.find((c) => c.projectId === item.projectId)
            if (container?.paneIds.includes(terminalId)) closePane(item.projectId, terminalId)
            // Backfill: terminal "viewer" criado antes do campo gsdSyncViewer
            // existir — sem isso a Sidebar de Projetos não sabe redirecionar
            // o clique dele pro fullscreen (trata como terminal comum).
            const termRecord = proj.terminals.find((term) => term.id === terminalId)
            if (termRecord && !termRecord.gsdSyncViewer)
              markGsdSyncViewer(item.projectId, terminalId)
          }

          // Limpeza de órfãos: terminais "GSD Sync" antigos que nunca tiveram
          // o `sessionId` da tab gravado (leftover de testes anteriores a essa
          // vinculação existir) não batem com `childId` acima, então o loop
          // de cima nem os enxerga — sem isso eles ficam presos na grade pra
          // sempre. Fecha qualquer outro terminal com esse nome na grade,
          // exceto o que acabou de ser resolvido como o "viewer" de verdade.
          const gsdPaneName = t('merge.gsdSyncPaneName')
          const container = containers.find((c) => c.projectId === item.projectId)
          if (container) {
            for (const term of proj.terminals) {
              if (
                term.id !== terminalId &&
                term.name === gsdPaneName &&
                container.paneIds.includes(term.id)
              ) {
                closePane(item.projectId, term.id)
              }
            }
          }

          const busy = await readGsdChildBusy(item.worktreePath).catch(() => false)
          const childError = await readGsdChildError(item.worktreePath).catch(() => null)
          if (childError)
            onChildErrorRef.current?.({ projectId: item.projectId, terminalId }, childError)

          resolvedIds.add(item.id)
          next.push({
            id: item.id,
            projectId: item.projectId,
            terminalId,
            childId,
            busy,
            hasError: Boolean(childError),
          })
        } catch (error) {
          // Sem isso, uma falha (ex.: `createTerminal` rejeitando) escapava
          // do loop inteiro como rejeição não tratada — abortava o resto de
          // `watched` NESTE tick, não só este item. Não marca `resolvedIds`
          // pra este item: tenta de novo sozinho no próximo tick de 5s.
          console.error(`[gsd-sync] falha processando ${item.id}:`, error)
        } finally {
          pollingRef.current.delete(item.id)
        }
      }
      // Merge por id em vez de substituição total: preserva entradas de itens
      // que um poll SOBREPOSTO ainda está processando (nunca em `resolvedIds`
      // nem em `next` aqui), atualiza/remove só o que este poll de fato
      // resolveu, e descarta qualquer entrada cuja worktree já não existe
      // mais em `watched` (merge integrado/rejeitado/abortado nesse meio
      // tempo).
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
  }, [watched, createTerminal, setSubTabSessionId, closePane, markGsdSyncViewer])
}

/** Leitura reativa das sessões GSD Sync descobertas pelo watcher acima — sem
 *  poll próprio. Usado pela gaveta GSD Sync e por qualquer outro consumidor
 *  que só precise LER a lista, não descobrir/criar nada. */
export function useGsdSyncSessions(): GsdSyncSession[] {
  return useGsdSyncSessionsStore((s) => s.sessions)
}

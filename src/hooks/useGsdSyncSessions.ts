import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'

import { useT } from '../lib/i18n'
import { readGsdChildState } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

export type GsdSyncSession = {
  id: string
  projectId: string
                                                                                          
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

                                                                      
                                                                             
                                                                            
// "achar-ou-criar terminal viewer" correriam em paralelo — a mesma corrida de
                                                                             
                                          
const useGsdSyncSessionsStore = create<{ sessions: GsdSyncSession[] }>(() => ({ sessions: [] }))

   
                                                            
                                                                            
                                                                             
                                                                            
                                                                          
                                                                              
                                                                               
                        
   
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
                                                                            
                                                                             
                                                                    
  const tRef = useRef(t)
  tRef.current = t

                                                                              
                                                                            
                                                                             
                                                                            
                                                                           
                                                                       
  //
                                                                            
                                                                           
                                                                      
                                                                        
                                                                        
                                                                           
                                                                         
                                                                         
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
                                                                             
      // corpo do poll muda `projects`/`containers` (createTerminal/closePane/
                                                                           
                                                                            
      // na hora) ENQUANTO o poll anterior ainda estava no meio do `await` de
                                                                             
                                                                          
                                                                          
                                                                  
      const { projects, workspace } = useProjectsStore.getState()
      const containers = workspace.containers
      const t = tRef.current
      const next: GsdSyncSession[] = []
                                                                 
                                                                            
                                                                             
                                                                         
                                    
      const resolvedIds = new Set<string>()
      for (const item of watched) {
                                                                            
                                                                           
                                                                             
        if (pollingRef.current.has(item.id)) continue
        pollingRef.current.add(item.id)
        try {
          const childState = await readGsdChildState(item.worktreePath).catch(() => null)
          const childId = childState?.sessionId ?? null
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
                                                                          
            // (comportamento certo pros outros ~15 call sites que usam ela,
                                                                           
                                                                             
                                                                            
                                                             
            closePane(item.projectId, created.id)
            terminalId = created.id
          } else {
                                                                         
                                                                       
            // comportamento existir, ou algum outro caminho) estar aberto na
                                                                            
                                                                          
            const container = containers.find((c) => c.projectId === item.projectId)
            if (container?.paneIds.includes(terminalId)) closePane(item.projectId, terminalId)
                                                                              
                                                                             
                                                                        
            const termRecord = proj.terminals.find((term) => term.id === terminalId)
            if (termRecord && !termRecord.gsdSyncViewer) markGsdSyncViewer(item.projectId, terminalId)
          }

                                                                              
          // o `sessionId` da tab gravado (leftover de testes anteriores a essa
                                                                            
                                                                             
                                                                          
          // exceto o que acabou de ser resolvido como o "viewer" de verdade.
          const gsdPaneName = t('merge.gsdSyncPaneName')
          const container = containers.find((c) => c.projectId === item.projectId)
          if (container) {
            for (const term of proj.terminals) {
              if (term.id !== terminalId && term.name === gsdPaneName && container.paneIds.includes(term.id)) {
                closePane(item.projectId, term.id)
              }
            }
          }

          const busy = childState?.busy ?? false
          const childError = childState?.error ?? null
          if (childError) onChildErrorRef.current?.({ projectId: item.projectId, terminalId }, childError)

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
                                                                            
                                                                            
                                                                            
                                                                        
          console.error(`[gsd-sync] falha processando ${item.id}:`, error)
        } finally {
          pollingRef.current.delete(item.id)
        }
      }
                                                                              
                                                                              
                                                                        
                                                                          
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

                                                                             
                                                                            
                                                            
export function useGsdSyncSessions(): GsdSyncSession[] {
  return useGsdSyncSessionsStore((s) => s.sessions)
}

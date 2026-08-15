   
                                                                        
                                                                             
                                                                           
                                                                             
                  
  
                                                                     
                                                              
   

import { getActiveSessions, saveSession } from './sessionResume'
import { acquireSpawnSlot, releaseSpawnSlot } from './spawnQueue'
import {
  getPtyCwd,
  restartPty,
  snapshotAntigravitySessions,
  snapshotClaudeSessions,
  snapshotCodexSessions,
  snapshotOpenCodeSessions,
} from './tauri'
import type { AgentType } from './types'
import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'

const RESUMABLE: AgentType[] = ['claude', 'codex', 'opencode', 'antigravity']

export type ResetLastSessionResult = { resumed: number; total: number }

                                                                              
function stripFlagWithValue(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++ // pula o valor associado
      continue
    }
    out.push(args[i])
  }
  return out
}

                                                                               
type SessionExclude = {
                                                                             
  id?: string
                                                                       
  before?: number
}

   
                                                                             
                                                                              
                                                                            
   
function pickSessionId(
  sessions: ReadonlyArray<{ id: string; modified_at_ms: number }>,
  exclude: SessionExclude,
): string | null {
  const candidates = sessions.filter((s) => s.id !== exclude.id)
  if (candidates.length === 0) return null
  const older = exclude.before ? candidates.filter((s) => s.modified_at_ms < exclude.before!) : []
  const pool = older.length > 0 ? older : candidates
  return pool.reduce((a, b) => (b.modified_at_ms > a.modified_at_ms ? b : a)).id
}

/** Acha o ID da conversa a retomar no disco para o cwd, por agente. */
async function latestSessionId(
  agent: AgentType,
  cwd: string,
  exclude: SessionExclude,
  savedOpenCodeId?: string,
): Promise<string | null> {
  if (!cwd) return null
  try {
    if (agent === 'codex') return pickSessionId(await snapshotCodexSessions(cwd), exclude)
    if (agent === 'claude') return pickSessionId(await snapshotClaudeSessions(cwd), exclude)
    if (agent === 'opencode') {
                                                                          
                                                         
                                                                               
                                                  
      if (savedOpenCodeId) return savedOpenCodeId
      const sessions = await snapshotOpenCodeSessions(cwd)
      if (sessions.length > 0) {
        return pickSessionId(sessions, exclude) ?? sessions[0].id
      }
      return null
    }
    if (agent === 'antigravity')
      return pickSessionId(await snapshotAntigravitySessions(cwd), exclude)
  } catch {
    return null
  }
  return null
}

                                                                             
function buildResumeArgs(agent: AgentType, baseArgs: string[], sessionId: string | null): string[] {
  if (agent === 'claude') {
    // Tira qualquer --resume <id> / --continue antigos e reinjeta o novo.
    const clean = stripFlagWithValue(baseArgs, '--resume').filter((a) => a !== '--continue')
    return sessionId ? ['--resume', sessionId, ...clean] : ['--continue', ...clean]
  }
  if (agent === 'codex') {
    // codex usa `resume <id>` / `resume --last` como subcomando (1º arg).
    let clean = baseArgs
    if (baseArgs[0] === 'resume') {
      const rest = baseArgs.slice(1)
      if (rest[0] && (rest[0] === '--last' || !rest[0].startsWith('-'))) rest.shift()
      clean = rest
    }
    return sessionId ? ['resume', sessionId, ...clean] : ['resume', '--last', ...clean]
  }
  if (agent === 'antigravity') {
    const clean = stripFlagWithValue(baseArgs, '--conversation').filter(
      (a) => a !== '--continue' && a !== '-c',
    )
    return sessionId ? ['--conversation', sessionId, ...clean] : ['--continue', ...clean]
  }
                                                                          
                            
  const clean = stripFlagWithValue(baseArgs, '--session').filter(
    (a) => a !== '--resume' && a !== '--continue',
  )
  return sessionId ? ['--session', sessionId, ...clean] : ['--continue', ...clean]
}

type ResumeTarget = {
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  agent: AgentType
  cwd: string
  extraArgs: string[]
}

                                                                       
function collectLivePanes(): ResumeTarget[] {
  const { projects } = useProjectsStore.getState()
  const { byPtyId } = useTerminalsStore.getState()
  const targets: ResumeTarget[] = []
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (!RESUMABLE.includes(tab.type)) continue
        const ptyId = tab.ptyId
        if (!ptyId || !byPtyId[ptyId]?.alive) continue
        targets.push({
          projectId: project.id,
          terminalId: terminal.id,
          tabId: tab.id,
          ptyId,
          agent: tab.type,
          cwd: (tab.cwd || terminal.cwd || '').trim(),
          extraArgs: tab.extraArgs ?? [],
        })
      }
    }
  }
  return targets
}

   
                                                                          
                                                                           
                                                            
   
export function countLiveResumablePanes(): number {
  return collectLivePanes().length
}

   
                                                                   
                                                                  
  
                                                                             
                                                                            
                                                                          
                                                                    
   
export async function resetLastSession(): Promise<ResetLastSessionResult> {
  const targets = collectLivePanes()
  let resumed = 0

  for (const target of targets) {
    const acquired = await acquireSpawnSlot()
    if (!acquired) continue
    try {
      let cwd = target.cwd
      if (!cwd) {
        const live = await getPtyCwd(target.ptyId).catch(() => null)
        cwd = (live ?? '').trim()
      }

                                                                         
      const active = getActiveSessions()[target.ptyId]
      const exclude: SessionExclude = {
        id:
          target.agent === 'codex'
            ? active?.codexSessionId
            : target.agent === 'opencode'
              ? active?.opencodeSessionId
              : active?.claudeSessionId,
        before: active?.timestamp,
      }
      const savedOpenCodeId = target.agent === 'opencode' ? active?.opencodeSessionId : undefined
      const sessionId = await latestSessionId(target.agent, cwd, exclude, savedOpenCodeId)
      const extraArgs = buildResumeArgs(target.agent, target.extraArgs, sessionId)

                                                                        
      useTerminalsStore.getState().beginRestart(target.ptyId)
      await restartPty({
        id: target.ptyId,
        cols: 80,
        rows: 24,
        command: target.agent,
        cwd: cwd || undefined,
        extraArgs,
      })
      window.dispatchEvent(
        new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId: target.ptyId } }),
      )

                                                                          
      saveSession(target.ptyId, {
        sessionId: target.ptyId,
        claudeSessionId: target.agent === 'claude' ? (sessionId ?? undefined) : undefined,
        codexSessionId: target.agent === 'codex' ? (sessionId ?? undefined) : undefined,
        opencodeSessionId: target.agent === 'opencode' ? (sessionId ?? undefined) : undefined,
        cwd,
        agent: target.agent,
        timestamp: Date.now(),
      })
      if (sessionId) {
        useProjectsStore
          .getState()
          .setSubTabSessionId(target.projectId, target.terminalId, target.tabId, sessionId)
      }

      resumed++
    } catch {
                                                 
    } finally {
      releaseSpawnSlot()
    }
  }

  return { resumed, total: targets.length }
}

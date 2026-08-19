import type { AgentType } from './types'

export type AgentLaunch = {
  args: string[]
  sessionId?: string
  createdSession: boolean
}

function stripFlagWithValue(args: string[], flags: ReadonlySet<string>): string[] {
  const clean: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (flags.has(args[index])) {
      index++
      continue
    }
    clean.push(args[index])
  }
  return clean
}

function stripClaudeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--resume', '-r', '--session-id'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

function stripCodexSessionArgs(args: string[]): string[] {
  if (args[0] !== 'resume') return [...args]
  const rest = args.slice(1)
  if (rest[0] === '--last' || (rest[0] && !rest[0].startsWith('-'))) rest.shift()
  return rest
}

function stripOpenCodeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--session', '-s'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c' && arg !== '--resume',
  )
}

function stripAntigravitySessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--conversation'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

   
                                                                            
                                                                             
                                                               
   
export function buildAgentLaunch(
  agent: AgentType,
  baseArgs: readonly string[] = [],
  sessionId?: string,
  createUuid: () => string = () => crypto.randomUUID(),
                                                                                 
                                                                                
                                                                               
                                                                        
                                                                              
                                                                                  
                                                                                   
  mcpConfigPaths?: readonly string[],
): AgentLaunch {
  if (agent === 'shell') {
    return { args: [...baseArgs], sessionId: undefined, createdSession: false }
  }

  if (agent === 'claude') {
    const clean = stripClaudeSessionArgs([...baseArgs])
    const mcp = (mcpConfigPaths ?? []).flatMap((path) => ['--mcp-config', path])
    if (sessionId) {
      return {
        args: ['--resume', sessionId, ...mcp, ...clean],
        sessionId,
        createdSession: false,
      }
    }
    const createdId = createUuid()
    return {
      args: ['--session-id', createdId, ...mcp, ...clean],
      sessionId: createdId,
      createdSession: true,
    }
  }

  if (agent === 'codex') {
    const clean = stripCodexSessionArgs([...baseArgs])
    return {
      args: sessionId ? ['resume', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'opencode') {
    const clean = stripOpenCodeSessionArgs([...baseArgs])
                                                                        
                                                                            
                                                                         
                                   
    return {
      args: sessionId ? ['--session', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'antigravity') {
    const clean = stripAntigravitySessionArgs([...baseArgs])
    return {
      args: sessionId ? ['--conversation', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

                                                                                  
                                                                                 
                                                                       
  return { args: [...baseArgs], sessionId: undefined, createdSession: false }
}

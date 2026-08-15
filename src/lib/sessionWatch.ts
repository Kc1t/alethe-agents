   
                                                                                 
                                                                                 
                                                                        
                                                                               
                                             
   

import { listen } from '@tauri-apps/api/event'

type WatchAgent = 'claude' | 'codex' | 'opencode'

const waiters: Record<WatchAgent, Array<() => void>> = { claude: [], codex: [], opencode: [] }
                                                                               
                                                                             
                                                                                    
const MAX_WAITERS = 64
let started = false

function ensureStarted(): void {
  if (started) return
  started = true
  void listen<{ agent?: string }>('session://new', (event) => {
    const agent = event.payload?.agent
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') return
    const pending = waiters[agent]
    waiters[agent] = []
    for (const resolve of pending) resolve()
  })
}

                                                                                          
export function waitForSessionHint(agent: WatchAgent): Promise<void> {
  ensureStarted()
  const arr = waiters[agent]
  while (arr.length >= MAX_WAITERS) {
    arr.shift()?.()
  }
  return new Promise((resolve) => {
    arr.push(resolve)
  })
}

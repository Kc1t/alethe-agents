import { releaseSessionClaim } from './sessionDiscovery'
import { removeSession } from './sessionResume'
import { ghosttyKill, killPtys } from './tauri'
import { useTerminalsStore } from '../stores/terminalsStore'

export function cleanupPtys(ptyIds: Array<string | null | undefined>): void {
  const uniqueIds = Array.from(new Set(ptyIds.filter((id): id is string => Boolean(id))))
  if (uniqueIds.length === 0) return

  const { unregister } = useTerminalsStore.getState()
  for (const ptyId of uniqueIds) {
    removeSession(ptyId)
    releaseSessionClaim(ptyId)
    unregister(ptyId)
    void ghosttyKill(ptyId).catch(() => {
                                                        
    })
  }
  void killPtys(uniqueIds).catch(() => {
    // The PTYs may already have exited or been killed by another action.
  })
}

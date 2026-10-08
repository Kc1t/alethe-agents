import { isOrchestratorShellPty } from './orchestratorShells'
import { releaseSessionClaim } from './sessionDiscovery'
import { removeSession } from './sessionResume'
import { ghosttyKill, killPtys } from './tauri'
import { useTerminalsStore } from '../stores/terminalsStore'

export function cleanupPtys(ptyIds: Array<string | null | undefined>): void {
  const uniqueIds = Array.from(new Set(ptyIds.filter((id): id is string => Boolean(id))))
  if (uniqueIds.length === 0) return

  const { unregister } = useTerminalsStore.getState()
  const owned: string[] = []
  for (const ptyId of uniqueIds) {
    unregister(ptyId)
    // The orchestrator owns these shells: closing a view of one only detaches it, and the service
    // keeps running until it is stopped from the board.
    if (isOrchestratorShellPty(ptyId)) continue
    removeSession(ptyId)
    releaseSessionClaim(ptyId)
    void ghosttyKill(ptyId).catch(() => {})
    owned.push(ptyId)
  }
  if (owned.length === 0) return
  void killPtys(owned).catch(() => {
    // The PTYs may already have exited or been killed by another action.
  })
}

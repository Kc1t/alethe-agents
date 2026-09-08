import { useCallback, useState } from 'react'

import { createUnrestrictedAgentState } from '../lib/agentCreation'
import type { AgentRuntimeProfile, AgentType } from '../lib/types'

export function useAgentCreationForm(initialType: AgentType) {
  const [type, setType] = useState<AgentType>(initialType)
  const [runtimeProfile, setRuntimeProfile] = useState<AgentRuntimeProfile>('lean')
  const [unrestricted, setUnrestricted] = useState(createUnrestrictedAgentState)

  const resetAgentCreation = useCallback(
    (nextType = initialType, unrestrictedDefault = false) => {
      setType(nextType)
      setRuntimeProfile('lean')
      setUnrestricted(createUnrestrictedAgentState(unrestrictedDefault))
    },
    [initialType],
  )

  const toggleUnrestricted = useCallback((agentType: AgentType) => {
    setUnrestricted((current) => ({ ...current, [agentType]: !current[agentType] }))
  }, [])

  return {
    resetAgentCreation,
    runtimeProfile,
    setRuntimeProfile,
    setType,
    toggleUnrestricted,
    type,
    unrestricted,
  }
}

import { useEffect, useState } from 'react'

import {
  acquireQuotaPolling,
  currentQuotaWarnings,
  type QuotaWarning,
  subscribeQuotaWarnings,
} from '../lib/orchestratorQuota'

export type { QuotaWarning }

export function useOrchestratorQuotaWarnings(): QuotaWarning[] {
  const [warnings, setWarnings] = useState<QuotaWarning[]>(currentQuotaWarnings)

  useEffect(() => {
    const unsubscribe = subscribeQuotaWarnings(setWarnings)
    const release = acquireQuotaPolling()
    return () => {
      unsubscribe()
      release()
    }
  }, [])

  return warnings
}

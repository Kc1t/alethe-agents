export const STARTUP_MARKS = {
  bundleEvaluating: 'alethe:startup:bundle-evaluating',
  bootstrapRequested: 'alethe:startup:bootstrap-requested',
  coreIdentityVerified: 'alethe:startup:core-identity-verified',
  uiUsable: 'alethe:startup:ui-usable',
} as const

export const STARTUP_MEASURES = {
  coreAttach: 'alethe:startup:core-attach',
  usableUi: 'alethe:startup:usable-ui',
} as const

export const STARTUP_BUDGET_MS = {
  warmCoreAttach: 500,
  warmUsableUi: 2_000,
  compiledStandaloneUsableUi: 3_000,
} as const

type StartupMark = (typeof STARTUP_MARKS)[keyof typeof STARTUP_MARKS]

function getPerformance(): Performance | null {
  return typeof performance === 'undefined' ? null : performance
}

export function markStartup(name: StartupMark): void {
  const target = getPerformance()
  if (!target || target.getEntriesByName(name, 'mark').length > 0) return
  target.mark(name)
}

export function measureStartup(
  name: (typeof STARTUP_MEASURES)[keyof typeof STARTUP_MEASURES],
  start: StartupMark,
  end: StartupMark,
): number | null {
  const target = getPerformance()
  if (!target || target.getEntriesByName(name, 'measure').length > 0) return null
  if (
    target.getEntriesByName(start, 'mark').length === 0 ||
    target.getEntriesByName(end, 'mark').length === 0
  ) {
    return null
  }
  target.measure(name, start, end)
  return target.getEntriesByName(name, 'measure')[0]?.duration ?? null
}

export function markCoreIdentityVerified(): void {
  markStartup(STARTUP_MARKS.coreIdentityVerified)
  measureStartup(
    STARTUP_MEASURES.coreAttach,
    STARTUP_MARKS.bootstrapRequested,
    STARTUP_MARKS.coreIdentityVerified,
  )
}

export function markUiUsable(): void {
  markStartup(STARTUP_MARKS.uiUsable)
  measureStartup(STARTUP_MEASURES.usableUi, STARTUP_MARKS.bundleEvaluating, STARTUP_MARKS.uiUsable)
}

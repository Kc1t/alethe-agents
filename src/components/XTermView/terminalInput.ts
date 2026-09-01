type WheelLike = {
  deltaMode: number
  deltaY: number
}

const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const PAGE_SCROLL_LINES = 10
export function getTerminalScrollbackRows(options?: {
  agent?: boolean
  memoryBudgetMb?: number
}): number {
  if (!options) return 10_000
  const budget = options.memoryBudgetMb ?? 1536
  if (budget <= 1536) return options.agent ? 6_000 : 3_000
  if (budget <= 3072) return options.agent ? 8_000 : 5_000
  return options.agent ? 10_000 : 6_000
}

   
                                                                             
                                   
  
                                                                               
                                                                                
                                                                                
                                                                                  
                                                                               
                    
   
export function shouldScrollHostScrollback(
  bufferType: 'normal' | 'alternate',
  shiftKey: boolean,
): boolean {
  if (shiftKey) return true
  return bufferType !== 'alternate'
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r')
}

   
                                                                             
                                                                           
                                                                           
   
export function formatDroppedPaths(paths: string[]): string {
  const formatted = paths
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(' ')
  return formatted ? `${formatted} ` : ''
}

export function getWheelScrollLines(event: WheelLike, lineHeight: number): number {
  if (event.deltaY === 0) return 0

  if (event.deltaMode === DOM_DELTA_LINE) {
    return Math.trunc(event.deltaY)
  }

  if (event.deltaMode !== DOM_DELTA_PIXEL) {
    return Math.sign(event.deltaY) * PAGE_SCROLL_LINES
  }

  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18
  const lines = Math.ceil(Math.abs(event.deltaY) / safeLineHeight)
  return Math.sign(event.deltaY) * Math.max(1, lines)
}

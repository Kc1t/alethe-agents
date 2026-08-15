import type { WebRect } from './tauri'

   
                                                                               
                                                                            
                                                                                
   
export function webRectsEqual(a: WebRect | null, b: WebRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

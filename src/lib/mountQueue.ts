   
                                                                           
                                                                         
                                                                          
                                                                        
                                                                           
                                               
   

const MAX_CONCURRENT_MOUNTS = 2
                                                                       
                                                                            
                                                                          
                                                                    
                                                      
const ACQUIRE_TIMEOUT_MS = 4000

let activeMounts = 0
const waiters: Array<() => void> = []

                                                                     
export function acquireMountSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    let settled = false
    const grant = () => {
      if (settled) return
      settled = true
      activeMounts++
      let released = false
      resolve(() => {
        if (released) return
        released = true
        activeMounts--
        const next = waiters.shift()
        if (next) next()
      })
    }
    if (activeMounts < MAX_CONCURRENT_MOUNTS) {
      grant()
      return
    }
    waiters.push(grant)
    window.setTimeout(() => {
      if (settled) return
      const idx = waiters.indexOf(grant)
      if (idx !== -1) waiters.splice(idx, 1)
      grant()
    }, ACQUIRE_TIMEOUT_MS)
  })
}

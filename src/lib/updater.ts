import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

                                                                   
export type UpdateInfo = {
  version: string
  currentVersion: string
  /** Release notes (corpo do `latest.json`), se houver. */
  notes: string | null
                                                             
  date: string | null
}

export type UpdateProgress = { downloaded: number; total: number }

                                                                               
                                                                                  
let pending: Update | null = null

   
                                                                               
                                                                              
                                                                           
                                                                         
   
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check()
  if (!update) {
    pending = null
    return null
  }
  pending = update
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? null,
    date: update.date ?? null,
  }
}

   
                                                                                 
                                                                             
   
export async function installPendingUpdate(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  // The banner lives in the store and outlives this module: a hot reload in development, or any
  // path that re-evaluates this file, leaves the notice on screen with nothing behind it. Asking
  // again costs one request and keeps the button honest instead of failing on a lost reference.
  if (!pending) pending = await check()
  if (!pending) throw new Error('No update is pending: it may already be installed.')
  let total = 0
  let downloaded = 0
  await pending.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0
        onProgress?.({ downloaded: 0, total })
        break
      case 'Progress':
        downloaded += event.data.chunkLength
        onProgress?.({ downloaded, total })
        break
      case 'Finished':
        onProgress?.({ downloaded: total, total })
        break
    }
  })
                                                                       
  await relaunch()
}

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
  if (!pending) throw new Error('Nenhum update pendente para instalar.')
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

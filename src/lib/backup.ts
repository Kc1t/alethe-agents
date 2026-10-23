import { useUiStore } from '../stores/uiStore'
import { getLocale, type Locale, translate } from './i18n'
import { restoreScopedStorage, scopedStorageSnapshot } from './storageNamespace'
import { type BackupReport, exportBackup, exportProfileBackup, importBackup } from './tauri/misc'

const LISTED_FILES = 3

export async function exportProfileState(
  targetPath: string,
  profileId?: string,
): Promise<BackupReport> {
  return profileId
    ? exportProfileBackup(profileId, targetPath, scopedStorageSnapshot(profileId))
    : exportBackup(targetPath, scopedStorageSnapshot())
}

export async function importProfileState(sourcePath: string): Promise<void> {
  const report = await importBackup(sourcePath)
  restoreScopedStorage(report.localStorage)
}

export function backupNotes(report: BackupReport, locale: Locale = getLocale()): string {
  const notes: string[] = []
  if (report.skipped.length > 0) {
    const listed = report.skipped.slice(0, LISTED_FILES).join(', ')
    notes.push(
      translate(locale, 'backup.skipped', {
        count: report.skipped.length,
        files:
          report.skipped.length > LISTED_FILES
            ? `${listed} (+${report.skipped.length - LISTED_FILES})`
            : listed,
      }),
    )
  }
  if (report.embeddedImages > 0) {
    notes.push(translate(locale, 'backup.embeddedImages', { count: report.embeddedImages }))
  }
  if (report.imageLinksKept.length > 0) {
    notes.push(translate(locale, 'backup.linksKept', { count: report.imageLinksKept.length }))
  }
  return notes.join(' ')
}

export function backupSummary(report: BackupReport, locale: Locale = getLocale()): string {
  const complete = report.skipped.length === 0 ? translate(locale, 'backup.complete') : ''
  return [complete, backupNotes(report, locale)].filter(Boolean).join(' ')
}

export function announceBackup(report: BackupReport): void {
  useUiStore.getState().pushToast({
    title: translate(getLocale(), 'backup.savedTitle'),
    body: backupSummary(report),
  })
}

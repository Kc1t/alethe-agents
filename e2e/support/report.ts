import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type StepStatus = 'pass' | 'fail'

type StepEntry = {
  scenario: string
  step: string
  status: StepStatus
  detail?: string
  screenshotPath?: string
  at: string
}

function runDir(): string {
  const dateStamp = new Date().toISOString().slice(0, 10)
  const dir = fileURLToPath(new URL(`../__reports__/${dateStamp}`, import.meta.url))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Records a scenario step in the day's report.json/report.md (append-only). */
export function recordStep(entry: Omit<StepEntry, 'at'>): void {
  const dir = runDir()
  const jsonPath = join(dir, 'report.json')
  const mdPath = join(dir, 'report.md')
  const full: StepEntry = { ...entry, at: new Date().toISOString() }

  const jsonLine = `${JSON.stringify(full)}\n`
  appendFileSync(jsonPath, jsonLine)

  if (!existsSync(mdPath)) {
    writeFileSync(
      mdPath,
      '# E2E Report\n\n| Status | Scenario | Step | Detail | Screenshot |\n|---|---|---|---|---|\n',
    )
  }
  const icon = full.status === 'pass' ? '✅' : '❌'
  const screenshotCell = full.screenshotPath ? `[img](${full.screenshotPath})` : ''
  appendFileSync(
    mdPath,
    `| ${icon} | ${full.scenario} | ${full.step} | ${full.detail ?? ''} | ${screenshotCell} |\n`,
  )
}

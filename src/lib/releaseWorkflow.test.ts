import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')

function jobBlocks(workflow: string): string[] {
  const lines = workflow.split('\n')
  const jobsIndex = lines.findIndex((line) => line === 'jobs:')
  const blocks: string[] = []
  let current: string[] | null = null

  for (const line of lines.slice(jobsIndex + 1)) {
    if (/^\s{2}[A-Za-z0-9_-]+:$/.test(line)) {
      if (current) blocks.push(current.join('\n'))
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }

  if (current) blocks.push(current.join('\n'))
  return blocks
}

describe('release workflow quality gate', () => {
  it('keeps CI event triggers while allowing release to call it', () => {
    expect(ciWorkflow).toMatch(/^\s{2}push:$/m)
    expect(ciWorkflow).toMatch(/^\s{2}pull_request:$/m)
    expect(ciWorkflow).toMatch(/^\s{2}workflow_call:$/m)
  })

  it('gates every Tauri publishing job on the reusable CI workflow', () => {
    const blocks = jobBlocks(releaseWorkflow)
    const qualityJob = blocks.find((block) => block.startsWith('  quality:'))
    const publishingJobs = blocks.filter((block) => block.includes('tauri-apps/tauri-action'))

    expect(qualityJob).toContain('uses: ./.github/workflows/ci.yml')
    expect(publishingJobs).not.toHaveLength(0)

    for (const job of publishingJobs) {
      expect(job).toMatch(/^\s{4}needs: quality$/m)
      expect(job).toMatch(/^\s{4}permissions:\n\s{6}contents: write$/m)
      expect(job).toContain('secrets.GITHUB_TOKEN')
      expect(job).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY')
      expect(job).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    }

    for (const job of blocks.filter((block) => !publishingJobs.includes(block))) {
      expect(job).not.toContain('permissions:')
      expect(job).not.toContain('secrets.')
    }
  })
})

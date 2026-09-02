import { describe, expect, it } from 'vitest'

import type { DiffSummaryEntry } from './api/git'
import { buildChangeProcedurePrompt, MAX_LISTED_FILES } from './changeProcedurePrompt'
import { translate } from './i18n'

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate('en', key, params)

function file(path: string, additions: number | null, deletions: number | null): DiffSummaryEntry {
  return { path, status: 'M', additions, deletions }
}

describe('change procedure prompt', () => {
  it('lists each changed file with its line counts', () => {
    const prompt = buildChangeProcedurePrompt(t, [
      file('src/chat.tsx', 12, 3),
      file('src-tauri/src/git.rs', 40, 0),
    ])

    expect(prompt).toContain('- src/chat.tsx (+12 -3)')
    expect(prompt).toContain('- src-tauri/src/git.rs (+40 -0)')
    expect(prompt).toContain('2 files changed')
  })

  it('omits counts for a binary file instead of reporting it as zero', () => {
    // "+0 -0" would read as "this file was touched but nothing changed", which is false — a binary
    // file has no line counts at all. The path on its own is the honest statement.
    const prompt = buildChangeProcedurePrompt(t, [file('assets/logo.png', null, null)])

    expect(prompt).toContain('- assets/logo.png')
    expect(prompt).not.toContain('+0')
  })

  it('caps the file list and says how many were left out', () => {
    // A prompt that pastes hundreds of paths into the terminal costs tokens and scrolls the
    // conversation away, while telling the agent nothing it cannot read from the repository.
    const many = Array.from({ length: MAX_LISTED_FILES + 25 }, (_, index) =>
      file(`src/file${index}.ts`, 1, 1),
    )
    const prompt = buildChangeProcedurePrompt(t, many)

    expect(prompt).toContain('src/file0.ts')
    expect(prompt).not.toContain(`src/file${MAX_LISTED_FILES}.ts (`)
    expect(prompt).toContain('25 more files')
    // The real total still has to be stated, or the agent underestimates the work it is describing.
    expect(prompt).toContain(`${many.length} files changed`)
  })

  it('always demands full coverage while allowing one step to cover many files', () => {
    const prompt = buildChangeProcedurePrompt(t, [file('a.ts', 1, 1)])

    expect(prompt).toMatch(/must be named by at least one step/)
    expect(prompt).toMatch(/One step may cover many files/)
    expect(prompt).toMatch(/how a person checks it/)
  })

  it('asks for an explicit choice on files whose existing step went stale', () => {
    // Amending the step that already exists and adding a new one are different outcomes, and only
    // the agent can tell which is right — so the prompt has to ask rather than assume.
    const prompt = buildChangeProcedurePrompt(t, [file('src/chat.tsx', 5, 2)], [
      { path: 'src/chat.tsx', stepSummary: 'chat grid' },
    ])

    expect(prompt).toContain('- src/chat.tsx — covered by: "chat grid"')
    expect(prompt).toMatch(/amend that existing step or add a new step/)
  })

  it('says nothing about stale coverage when there is none', () => {
    const prompt = buildChangeProcedurePrompt(t, [file('a.ts', 1, 1)])

    expect(prompt).not.toMatch(/already covered by an earlier step/)
  })
})

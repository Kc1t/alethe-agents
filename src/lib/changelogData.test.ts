import { describe, expect, it } from 'vitest'

import packageJson from '../../package.json'
import { CHANGELOG_RELEASES, CURRENT_VERSION } from './changelogData'
import { en } from './i18n/messages/en'
import { ptBR } from './i18n/messages/pt-BR'

function compareVersionsDescending(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

describe('CHANGELOG_RELEASES', () => {
  it('matches the packaged application version', () => {
    expect(CURRENT_VERSION).toBe(packageJson.version)
  })

  it('keeps releases unique and sorted newest-first', () => {
    const versions = CHANGELOG_RELEASES.map((release) => release.version)

    for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual([...versions].sort(compareVersionsDescending))
  })

  it('uses real ISO calendar dates', () => {
    for (const release of CHANGELOG_RELEASES) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(new Date(`${release.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(release.date)
    }
  })

  it('references non-empty messages in every locale', () => {
    for (const release of CHANGELOG_RELEASES) {
      for (const noteKey of release.noteKeys) {
        expect(en).toHaveProperty(noteKey)
        expect(en[noteKey].trim()).not.toBe('')
        expect(ptBR[noteKey].trim()).not.toBe('')
      }
    }
  })
})

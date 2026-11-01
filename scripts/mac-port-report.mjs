#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = path.join(ROOT, 'docs', 'MAC_PORT.md')

const SKIPPED_TYPES = new Set(['docs', 'style', 'ci', 'test', 'chore', 'build'])
const NON_PRODUCT_FILE = [
  /^docs\//,
  /^\.github\//,
  /^e2e\//,
  /\.md$/i,
  /\.test\.tsx?$/,
  /^previews\//,
]
const PLATFORM_FILE = [
  /windows/i,
  /win32/i,
  /\bwsl/i,
  /conpty/i,
  /nsis/i,
  /\.msi\b/i,
  /\.ps1$/i,
  /appimage/i,
  /linux/i,
]
const PLATFORM_SUBJECT =
  /\b(wsl|windows|linux|appimage|wayland|d-bus|klipper|msi|nsis|conpty|powershell|administrator)\b/i
const CONTRACT_FILE = [
  /cloudSync/i,
  /cloud_sync\.rs$/,
  /projectSync/i,
  /toolingManifest/i,
  /Persistence/,
  /\.migrations\.ts$/,
  /^src-tauri\/src\/(backup|profiles|paths)\.rs$/,
  /^src\/lib\/sync\//,
]

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function parseArgs(argv) {
  const opts = { from: null, to: 'HEAD', check: false, all: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--from') opts.from = argv[++i]
    else if (arg === '--to') opts.to = argv[++i]
    else if (arg === '--check') opts.check = true
    else if (arg === '--all') opts.all = true
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return opts
}

function refExists(ref) {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
    return true
  } catch {
    return false
  }
}

function syncedThroughFromLedger(ledger) {
  return ledger.match(/^Mac synced through:\s*`([^`]+)`/m)?.[1] ?? null
}

function resolveFrom(opts, ledger) {
  if (opts.from) return opts.from
  if (refExists('mac-synced')) return 'mac-synced'
  const fromLedger = syncedThroughFromLedger(ledger)
  if (fromLedger) return fromLedger
  console.error(
    'No baseline: pass --from <ref>, create the mac-synced tag, or set "Mac synced through" in docs/MAC_PORT.md.',
  )
  process.exit(2)
}

function readCommits(range) {
  const raw = git(
    'log',
    '--no-merges',
    '--reverse',
    '--name-only',
    '--format=%x1e%h%x1f%s%x1f%(trailers:key=Mac-Port,valueonly,separator=%x2c)',
    range,
  )
  return raw
    .split('\x1e')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [header, ...rest] = chunk.split('\n')
      const [sha, subject, trailer] = header.split('\x1f')
      return {
        sha,
        subject,
        trailer: trailer.trim(),
        files: rest.map((f) => f.trim()).filter(Boolean),
      }
    })
}

function commitType(subject) {
  return subject.match(/^([a-z]+)(\(([^)]+)\))?!?:/)?.[1] ?? null
}

function commitScope(subject) {
  return subject.match(/^[a-z]+\(([^)]+)\)/)?.[1] ?? 'general'
}

const matchesAny = (patterns, file) => patterns.some((re) => re.test(file))

function classify(commit) {
  const trailer = commit.trailer.toLowerCase()
  if (trailer.startsWith('skip') || trailer === 'n/a')
    return { status: 'skip', reason: commit.trailer }
  if (/^chore\(release\)/.test(commit.subject)) return { status: 'skip', reason: 'release commit' }

  const type = commitType(commit.subject)
  const productFiles = commit.files.filter((f) => !matchesAny(NON_PRODUCT_FILE, f))
  if (!trailer && (SKIPPED_TYPES.has(type) || productFiles.length === 0)) {
    return { status: 'skip', reason: type ? `${type} commit` : 'no product files' }
  }

  let kind = 'ui'
  if (
    PLATFORM_SUBJECT.test(commit.subject) ||
    productFiles.every((f) => matchesAny(PLATFORM_FILE, f))
  )
    kind = 'platform'
  else if (productFiles.some((f) => matchesAny(CONTRACT_FILE, f))) kind = 'contract'
  else if (productFiles.every((f) => f.startsWith('src-tauri/'))) kind = 'backend'

  return {
    status: trailer.startsWith('required') ? 'pending' : 'needs-triage',
    kind,
    scope: commitScope(commit.subject),
    files: productFiles,
  }
}

function keyFiles(files) {
  const ranked = [...files].sort(
    (a, b) => Number(/i18n\/messages/.test(a)) - Number(/i18n\/messages/.test(b)),
  )
  const shown = ranked.slice(0, 3).map((f) => `\`${f}\``)
  return files.length > 3 ? `${shown.join(', ')} +${files.length - 3}` : shown.join(', ')
}

function render(range, items, skipped, showSkipped) {
  const order = ['contract', 'backend', 'ui', 'platform']
  const lines = [`# Mac port report: \`${range}\``, '']
  lines.push(`${items.length} to port, ${skipped.length} skipped.`, '')
  for (const kind of order) {
    const group = items.filter((i) => i.kind === kind)
    if (!group.length) continue
    lines.push(`## ${kind}`, '')
    for (const i of group) {
      const tracked = i.inLedger ? '' : ' **(not in MAC_PORT.md)**'
      lines.push(`- \`${i.status}\` · \`${i.kind}\` · \`${i.sha}\` ${i.subject}${tracked}`)
      if (i.files.length) lines.push(`  - Files: ${keyFiles(i.files)}`)
    }
    lines.push('')
  }
  if (showSkipped && skipped.length) {
    lines.push('## skipped', '')
    for (const s of skipped) lines.push(`- \`${s.sha}\` ${s.subject} (${s.reason})`)
    lines.push('')
  }
  return lines.join('\n')
}

const opts = parseArgs(process.argv.slice(2))
const ledger = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : ''
const range = `${resolveFrom(opts, ledger)}..${opts.to}`

const items = []
const skipped = []
for (const commit of readCommits(range)) {
  const result = classify(commit)
  const inLedger = ledger.includes(`\`${commit.sha}\``) || ledger.includes(commit.subject)
  if (result.status === 'skip') skipped.push({ ...commit, ...result })
  else items.push({ ...commit, ...result, inLedger })
}

if (opts.check) {
  const untracked = items.filter((i) => !i.inLedger)
  if (untracked.length) {
    console.error(`${untracked.length} commit(s) in ${range} need a docs/MAC_PORT.md entry:`)
    for (const i of untracked) console.error(`  ${i.sha} ${i.subject}`)
    process.exit(1)
  }
  console.log(`Every portable commit in ${range} is tracked in docs/MAC_PORT.md.`)
} else {
  console.log(render(range, items, skipped, opts.all))
}

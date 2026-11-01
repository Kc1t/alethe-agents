#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = 'alethe'
const LEGACY_SKILLS = ['alethe-orchestrate']
const REPOSITORY = 'https://github.com/Kc1t/alethe-orchestrate-skill'
const SKILLS_DIR = path.join(ROOT, 'src-tauri', 'assets', 'skills')
const VENDORED = path.join(SKILLS_DIR, SKILL)
const SOURCES = path.join(SKILLS_DIR, 'sources.json')
const SKILLS_RS = path.join(ROOT, 'src-tauri', 'src', 'skills.rs')
const FILES_BEGIN = '// skill:sync files begin'
const FILES_END = '// skill:sync files end'
const IGNORED = /(^|\/)(__pycache__|\.DS_Store)(\/|$)|\.pyc$/

function parseArgs(argv) {
  const opts = { from: null, ref: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--from') opts.from = argv[++i]
    else if (arg === '--ref') opts.ref = argv[++i]
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return opts
}

function fail(message) {
  throw new Error(message)
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    const relative = path.relative(base, full).split(path.sep).join('/')
    if (IGNORED.test(relative)) return []
    return entry.isDirectory() ? listFiles(full, base) : [relative]
  })
}

function skillVersion(skillDir) {
  const frontmatter = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8').split('\n---')[0]
  if (!new RegExp(`^name:\\s*${SKILL}\\s*$`, 'm').test(frontmatter)) fail(`skills/${SKILL}/SKILL.md is not named ${SKILL}`)
  const version = Number(frontmatter.match(/^\s+version:\s*"?(\d+)"?\s*$/m)?.[1])
  if (!Number.isInteger(version)) fail(`skills/${SKILL}/SKILL.md has no metadata.version`)
  return version
}

function textOnly(skillDir, files) {
  for (const file of files) {
    const bytes = readFileSync(path.join(skillDir, ...file.split('/')))
    if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail(`${file} is not UTF-8 text; include_str! can only bundle text files`)
    }
  }
}

function fileEntry(file) {
  const constant = file === 'SKILL.md' ? 'SKILL_FILE' : JSON.stringify(file)
  return [
    '        BundledSkillFile {',
    `            path: ${constant},`,
    `            content: include_str!("../assets/skills/${SKILL}/${file}"),`,
    '        },',
  ].join('\n')
}

function updatedRust(rust, version, files) {
  const versionPattern = new RegExp(`(name: "${SKILL}",[\\s\\S]*?version: )\\d+`)
  if (!versionPattern.test(rust)) fail(`Could not find the ${SKILL} version in src-tauri/src/skills.rs`)
  const begin = rust.indexOf(FILES_BEGIN)
  const end = rust.indexOf(FILES_END)
  if (begin === -1 || end === -1 || end < begin) fail(`src-tauri/src/skills.rs has no "${FILES_BEGIN}" block`)
  const lineStart = rust.lastIndexOf('\n', end) + 1
  const ordered = ['SKILL.md', ...files.filter((file) => file !== 'SKILL.md')]
  const block = `${FILES_BEGIN}\n${ordered.map(fileEntry).join('\n')}\n`
  return (rust.slice(0, begin) + block + rust.slice(lineStart)).replace(versionPattern, `$1${version}`)
}

const opts = parseArgs(process.argv.slice(2))
const checkout = mkdtempSync(path.join(tmpdir(), 'alethe-skill-'))
const staging = `${VENDORED}.sync-${process.pid}`
try {
  const from = opts.from ? path.resolve(opts.from) : null
  git(ROOT, 'clone', '--quiet', from ?? `${REPOSITORY}.git`, checkout)
  if (opts.ref) git(checkout, 'checkout', '--quiet', '--detach', opts.ref)
  const commit = git(checkout, 'rev-parse', 'HEAD')
  const skillDir = path.join(checkout, 'skills', SKILL)
  if (!existsSync(path.join(skillDir, 'SKILL.md'))) fail(`No skills/${SKILL}/SKILL.md in ${commit}`)
  const version = skillVersion(skillDir)
  const files = listFiles(skillDir).sort()
  textOnly(skillDir, files)
  const rust = updatedRust(readFileSync(SKILLS_RS, 'utf8'), version, files)
  if (from && !git(from, 'branch', '-r', '--contains', commit)) {
    console.warn(`warning: ${commit.slice(0, 7)} is not on any remote branch of ${from}; push it before releasing`)
  }

  rmSync(staging, { recursive: true, force: true })
  for (const file of files) {
    const target = path.join(staging, ...file.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(skillDir, ...file.split('/')), target)
  }
  rmSync(VENDORED, { recursive: true, force: true })
  renameSync(staging, VENDORED)
  for (const legacy of LEGACY_SKILLS) rmSync(path.join(SKILLS_DIR, legacy), { recursive: true, force: true })
  writeFileSync(SKILLS_RS, rust)

  const sources = existsSync(SOURCES) ? JSON.parse(readFileSync(SOURCES, 'utf8')) : {}
  for (const legacy of LEGACY_SKILLS) delete sources[legacy]
  sources[SKILL] = { repository: REPOSITORY, commit, version, ...(opts.ref ? { ref: opts.ref } : {}) }
  writeFileSync(SOURCES, `${JSON.stringify(sources, null, 2)}\n`)
  console.log(`Synced ${SKILL} ${version} from ${commit.slice(0, 7)} (${files.length} files).`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  rmSync(staging, { recursive: true, force: true, maxRetries: 3 })
  rmSync(checkout, { recursive: true, force: true, maxRetries: 3 })
}

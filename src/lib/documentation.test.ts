import overview from '../../docs/OVERVIEW.md?raw'
import privacy from '../../docs/PRIVACY.md?raw'
import readme from '../../README.md?raw'
import security from '../../SECURITY.md?raw'

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

describe('security and privacy documentation', () => {
  it('keeps the security reporting contract private and appropriately scoped', () => {
    const text = normalize(security)

    expect(text).toContain('Supported versions')
    expect(text).toContain('contact@kc1t.com')
    expect(text).toContain('Do not open a public issue')
    expect(text).toContain('Coordinated disclosure')
    expect(text).toContain('Bugs, questions, and feature requests')
    expect(text).toContain('does not currently promise')
    expect(text).toContain('defense in depth')
    expect(text).toContain('not a containment boundary for privileged Tauri commands')
  })

  it('documents retention, secrets, subprocesses, and every major network default', () => {
    const text = normalize(privacy)

    for (const required of [
      'Local-first, not local-only',
      'Local data, retention, export, and deletion',
      'Secrets and credentials',
      'Local telemetry and diagnostics',
      'Network and process inventory',
      'Coding-agent CLIs and other subprocesses',
      'Handoff artifacts and redaction limits',
      'Embedded content, CSP, and privileged commands',
      'Automatic update check | **On**',
      'Provider usage polling | **On**',
      'Discord Rich Presence | **On**',
      'Spotify Now Playing | **Off / unconfigured**',
      'GitHub Sync | **Off / disconnected; manual**',
      'MCP registry | **MCP feature on; search on demand**',
      'Embedded web content | **Browser feature on; no page open**',
      'LAN Remote Control | **Off**',
      'Agent-event hook listener | **On, loopback only**',
      'AI Memory bridge | **Off**',
      'Development server | **Development only**',
      'no rotation or size cap',
      'no telemetry upload client',
      'at most 20 files per prefix',
      'does not include profile `spawn.log`',
      'current Windows installers are not code-signed',
      'JavaScript is **on by default**',
      'defense in depth',
      'not privileged-command containment',
    ]) {
      expect(text, `missing privacy statement: ${required}`).toContain(required)
    }
  })

  it('rejects broad internet-free claims', () => {
    const docs = normalize(`${readme}\n${overview}\n${security}\n${privacy}`)

    expect(docs).not.toMatch(/\bnever connects? (?:to )?(?:the )?internet\b/i)
    expect(docs).not.toMatch(/\bdoes not connect (?:to )?(?:the )?internet\b/i)
    expect(docs).not.toMatch(/\bno (?:external )?network (?:access|traffic|connections?)\b/i)
  })

  it('keeps top-level local-first claims linked to concrete qualifications', () => {
    const readmeText = normalize(readme)
    const overviewText = normalize(overview)

    expect(readmeText).toContain(
      '“Local-first” describes workspace persistence, not an internet-free guarantee',
    )
    expect(readmeText).toContain('update checks and provider usage polling are on by default')
    expect(readmeText).toContain('Manual GitHub Gist Sync is already available')
    expect(readmeText).toContain('Redaction is best effort')
    expect(readmeText).toContain('unencrypted HTTP/WebSocket transport')
    expect(readmeText).toContain('Clean profiles are read-only')
    expect(readmeText).not.toContain('This is a false positive')
    expect(overviewText).toContain('root-level `logs/`')
    expect(overviewText).toContain('plaintext credential storage')
  })
})

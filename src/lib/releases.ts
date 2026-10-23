const REPO = 'Kc1t/alethe-agents'
const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=50`
const REQUEST_TIMEOUT_MS = 10_000
const PLAIN_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/

export const ALL_RELEASES_URL = `https://github.com/${REPO}/releases`

export type AletheRelease = {
  version: string
  publishedAt: string | null
  installable: boolean
}

export function releasePageUrl(version: string): string {
  return `${ALL_RELEASES_URL}/tag/v${version}`
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function hasAsset(assets: unknown, name: string): boolean {
  return (
    Array.isArray(assets) &&
    assets.some(
      (asset) =>
        typeof asset === 'object' && asset !== null && (asset as { name?: unknown }).name === name,
    )
  )
}

export function parseReleases(payload: unknown): AletheRelease[] {
  if (!Array.isArray(payload)) return []
  const releases: AletheRelease[] = []
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) continue
    const release = item as Record<string, unknown>
    if (release.draft === true || release.prerelease === true) continue
    if (!Array.isArray(release.assets) || release.assets.length === 0) continue
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
    if (!PLAIN_VERSION.test(version)) continue
    releases.push({
      version,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      installable: hasAsset(release.assets, 'latest.json'),
    })
  }
  return releases
}

export function olderReleases(releases: AletheRelease[], current: string): AletheRelease[] {
  return releases
    .filter((release) => compareVersions(release.version, current) < 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}

export async function fetchAletheReleases(): Promise<AletheRelease[]> {
  const response = await fetch(RELEASES_API_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
  return parseReleases(await response.json())
}

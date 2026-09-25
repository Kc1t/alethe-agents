import { normalizeCwd } from './platform'

export { normalizeCwd }

export function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

export function basename(path: string): string {
  const segments = pathSegments(path)
  return segments[segments.length - 1] ?? ''
}

export function sameCwd(a: string, b: string): boolean {
  return normalizeCwd(a) === normalizeCwd(b)
}

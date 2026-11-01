export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export const sameValue = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b)

export type FieldMergeOptions = {
  absentIsNoOpinion?: boolean
}

export function mergeFields<T extends Record<string, unknown>>(
  base: T | null,
  local: T,
  remote: T,
  options: FieldMergeOptions = {},
): T {
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base ?? {})])
  const merged: Record<string, unknown> = {}
  for (const key of keys) {
    const l = local[key]
    const r = remote[key]
    let value: unknown
    if (sameValue(l, r)) value = l
    else if (options.absentIsNoOpinion && r === undefined) value = l
    else if (options.absentIsNoOpinion && l === undefined) value = r
    else if (base === null) value = r
    else if (sameValue(l, base[key])) value = r
    else if (sameValue(r, base[key])) value = l
    else value = l
    if (value !== undefined) merged[key] = value
  }
  return merged as T
}

export function mergeKeyed<T extends Record<string, unknown>>(
  base: Record<string, T> | null,
  local: Record<string, T>,
  remote: Record<string, T>,
): Record<string, T> {
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)])
  const merged: Record<string, T> = {}
  for (const id of ids) {
    const b = base?.[id]
    const l = local[id]
    const r = remote[id]
    if (l && r) {
      merged[id] = mergeFields(b ?? null, l, r)
    } else if (l) {
      if (!b || !sameValue(l, b)) merged[id] = l
    } else if (r) {
      if (!b || !sameValue(r, b)) merged[id] = r
    }
  }
  return merged
}

export function keyedBy<T>(items: readonly T[], key: (item: T) => string): Record<string, T> {
  const out: Record<string, T> = {}
  for (const item of items) out[key(item)] = item
  return out
}

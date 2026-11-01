const YAML_MAX_DEPTH = 100

type Line = [number, number, string]
type Read<T> = [T, number]

export class PlaybooksYamlError extends Error {
  constructor(
    readonly line: number,
    readonly reason: string,
  ) {
    super(`line ${line}: ${reason}`)
  }
}

const hasKey = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key)
const space = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)
const isItem = (text: string) => text === '-' || text.startsWith('- ')
const isQuote = (ch: string | undefined) => ch === '"' || ch === "'"
const ESCAPES: Record<string, string> = {
  0: '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: ' ',
  P: ' ',
}

function fail(line: number, reason: string): never {
  throw new PlaybooksYamlError(line, reason)
}

function uncomment(s: string): string {
  let quote: string | null = null
  let previous = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++
        continue
      }
      if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") {
          i++
          continue
        }
        quote = null
      }
    } else if (ch === '#' && (i === 0 || space(s[i - 1]))) return s.slice(0, i)
    else if (isQuote(ch) && (!previous || ':,[{-'.includes(previous))) quote = ch
    if (!space(ch)) previous = ch
  }
  return s
}

function quoted(s: string, start: number, line: number): Read<string> {
  const quote = s[start]
  let out = ''
  let i = start + 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === quote) {
      if (quote === "'" && s[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      return [out, i + 1]
    }
    if (ch === '\\' && quote === '"') {
      i++
      if (i === s.length) fail(line, 'unfinished quoted escape')
      const escape = s[i]
      if ('xuU'.includes(escape)) {
        const count = { x: 2, u: 4, U: 8 }[escape as 'x' | 'u' | 'U']
        const digits = s.slice(i + 1, i + 1 + count)
        if (digits.length !== count || !/^[0-9a-fA-F]+$/.test(digits))
          fail(line, 'invalid Unicode escape')
        const code = parseInt(digits, 16)
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
          fail(line, 'invalid Unicode code point')
        out += String.fromCodePoint(code)
        i += count + 1
        continue
      }
      if (!hasKey(ESCAPES, escape)) fail(line, `unsupported escape \\${escape}`)
      out += ESCAPES[escape]
      i++
      continue
    }
    out += ch
    i++
  }
  return fail(line, 'unterminated quoted string')
}

function scalar(s: string, line: number): unknown {
  if (!s || '&*!|>@%`,]}{[?:'.includes(s[0]) || ['---', '...', '-'].includes(s))
    fail(line, 'unsupported YAML syntax or missing scalar')
  if (/:(\s|$)/.test(s)) fail(line, 'unexpected mapping in scalar')
  if (s === 'true' || s === 'false') return s === 'true'
  if (
    [
      'null',
      '~',
      'yes',
      'no',
      'on',
      'off',
      'true',
      'false',
      '.inf',
      '+.inf',
      '-.inf',
      '.nan',
    ].includes(s.toLowerCase())
  )
    fail(line, 'quote this scalar; only true/false booleans are supported')
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(s)) return Number(s)
  if (/^[-+]?([0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)([eE][-+]?[0-9]+)?$/.test(s)) {
    const number = Number(s)
    if (!Number.isFinite(number)) fail(line, 'non-finite numbers are unsupported')
    return number
  }
  if (/^[-+]?[0-9]/.test(s) && /^[-+]?[0-9_:xXoObBa-fA-F.]+$/.test(s))
    fail(line, 'unsupported numeric syntax; use a decimal number or quote it')
  return s
}

function put(target: Record<string, unknown>, key: string, value: unknown, line: number) {
  if (key === '__proto__') fail(line, 'the key __proto__ is reserved')
  if (hasKey(target, key)) fail(line, `duplicate mapping key '${key}'`)
  target[key] = value
}

function flowValue(
  s: string,
  start: number,
  line: number,
  depth: number,
  flow: boolean,
): Read<unknown> {
  if (depth > YAML_MAX_DEPTH) fail(line, 'YAML nesting is too deep')
  let i = start
  while (i < s.length && space(s[i])) i++
  if (i === s.length) fail(line, 'missing scalar value')
  if (isQuote(s[i])) return quoted(s, i, line)
  if (s[i] === '[' || s[i] === '{') {
    const mapping = s[i] === '{'
    const closing = mapping ? '}' : ']'
    const map: Record<string, unknown> = {}
    const list: unknown[] = []
    const result = mapping ? map : list
    i++
    while (i < s.length && space(s[i])) i++
    if (s[i] === closing) return [result, i + 1]
    while (i < s.length) {
      if (mapping) {
        let key: unknown
        if (isQuote(s[i])) {
          const read = quoted(s, i, line)
          key = read[0]
          i = read[1]
        } else {
          let end = i
          while (end < s.length && !':,{}[]'.includes(s[end])) end++
          key = scalar(s.slice(i, end).trim(), line)
          i = end
        }
        while (i < s.length && space(s[i])) i++
        if (typeof key !== 'string' || !key || key === '<<')
          fail(line, 'flow mapping keys must be non-empty strings')
        if (s[i] !== ':') fail(line, "expected ':' in flow mapping")
        const read = flowValue(s, i + 1, line, depth + 1, true)
        put(map, key, read[0], line)
        i = read[1]
      } else {
        const read = flowValue(s, i, line, depth + 1, true)
        list.push(read[0])
        i = read[1]
      }
      while (i < s.length && space(s[i])) i++
      if (s[i] === closing) return [result, i + 1]
      if (s[i] !== ',') fail(line, `expected ',' or '${closing}'`)
      i++
      while (i < s.length && space(s[i])) i++
      if (i === s.length || s[i] === closing) fail(line, "missing value after ','")
    }
    fail(line, `unclosed flow collection, expected '${closing}'`)
  }
  let end = i
  while (end < s.length && (!flow || !',]}{'.includes(s[end]))) end++
  return [scalar(s.slice(i, end).trim(), line), end]
}

function value(s: string, line: number): unknown {
  const read = flowValue(s, 0, line, 0, false)
  if (s.slice(read[1]).trim()) fail(line, 'unexpected text after value')
  return read[0]
}

function entry(s: string, line: number): [string, string] {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++
        continue
      }
      if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") {
          i++
          continue
        }
        quote = null
      }
    } else if (i === 0 && isQuote(ch)) quote = ch
    else if (ch === ':' && (i + 1 === s.length || space(s[i + 1]))) {
      const key = value(s.slice(0, i).trim(), line)
      if (typeof key !== 'string' || !key || key === '<<')
        fail(line, 'mapping keys must be non-empty strings; merges are unsupported')
      return [key, s.slice(i + 1).trim()]
    }
  }
  return fail(line, 'expected a block mapping entry')
}

export function parsePlaybooksYaml(text: string): unknown {
  const lines: Line[] = []
  text.split(/\r\n|\r|\n/).forEach((raw, n) => {
    const indent = raw.length - raw.replace(/^[ \t]+/, '').length
    if (raw.slice(0, indent).includes('\t')) fail(n + 1, 'tabs are not supported for indentation')
    const content = uncomment(raw.slice(indent)).trimEnd()
    if (content) lines.push([n + 1, indent, content])
  })
  let index = 0

  function blockEntry(s: string, line: number, indent: number, depth: number): [string, unknown] {
    const [key, rest] = entry(s, line)
    if (rest) return [key, value(rest, line)]
    const empty = `${key} needs a value; use {} or [] for an empty collection`
    if (index === lines.length) fail(line, empty)
    const [, childIndent, childText] = lines[index]
    if (childIndent <= indent && !(childIndent === indent && childText.startsWith('- ')))
      fail(line, empty)
    return [key, block(childIndent, depth + 1)]
  }

  function block(indent: number, depth: number): unknown[] | Record<string, unknown> {
    if (depth > YAML_MAX_DEPTH) fail(lines[index][0], 'YAML nesting is too deep')
    const isList = isItem(lines[index][2])
    const list: unknown[] = []
    const map: Record<string, unknown> = {}
    while (index < lines.length) {
      const [line, actual, text] = lines[index]
      if (actual < indent) break
      if (actual !== indent) fail(line, 'inconsistent indentation')
      if (isList && !isItem(text)) break
      if (!isList && isItem(text)) fail(line, 'cannot mix a block list and mapping')
      index++
      if (!isList) {
        const [key, val] = blockEntry(text, line, indent, depth)
        put(map, key, val, line)
        continue
      }
      const item = text.slice(1).trim()
      if (!item) fail(line, 'block list items need a scalar or mapping')
      let mappingItem = !'[{'.includes(item[0]) && /:(\s|$)/.test(item)
      if (isQuote(item[0]))
        mappingItem = /^:(\s|$)/.test(item.slice(quoted(item, 0, line)[1]).trimStart())
      if (!mappingItem) {
        list.push(value(item, line))
        continue
      }
      const mappingIndent = indent + text.indexOf(item)
      const fields: Record<string, unknown> = {}
      const [key, val] = blockEntry(item, line, mappingIndent, depth + 1)
      put(fields, key, val, line)
      if (index < lines.length && lines[index][1] > indent) {
        const more = block(mappingIndent, depth + 1)
        if (Array.isArray(more))
          fail(lines[index - 1][0], 'expected mapping fields after list item')
        Object.entries(more).forEach(([k, v]) => put(fields, k, v, line))
      }
      list.push(fields)
    }
    return isList ? list : map
  }

  if (!lines.length) fail(1, 'playbooks must not be empty')
  if (lines[0][1] !== 0) fail(lines[0][0], 'top-level indentation must be zero')
  if (lines.length === 1 && '[{'.includes(lines[0][2][0])) return value(lines[0][2], lines[0][0])
  const result = block(0, 0)
  if (index < lines.length) fail(lines[index][0], 'unexpected indentation')
  return result
}

function yScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  if (
    /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(s) &&
    !/^[\d.]+$/.test(s) &&
    !/^\d{4}-\d{2}-\d{2}/.test(s)
  )
    return s
  return JSON.stringify(s)
}

const isScalar = (v: unknown) => v === null || typeof v !== 'object'

function inlineMap(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(yScalar).join(', ')}]` : yScalar(v)}`)
  return `{ ${entries.join(', ')} }`
}

const inlinable = (obj: Record<string, unknown>) =>
  Object.values(obj).every(
    (v) => v === undefined || isScalar(v) || (Array.isArray(v) && v.every(isScalar)),
  )

function emit(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (!value.length) return ' []'
    if (value.every(isScalar)) {
      const flat = `[${value.map(yScalar).join(', ')}]`
      return flat.length < 80
        ? ` ${flat}`
        : '\n' + value.map((v) => `${pad}- ${yScalar(v)}`).join('\n')
    }
    return (
      '\n' +
      value
        .map((item) => {
          if (isScalar(item)) return `${pad}- ${yScalar(item)}`
          const map = item as Record<string, unknown>
          const entries = Object.entries(map).filter(([, v]) => v !== undefined)
          if (inlinable(map) && inlineMap(map).length < 96) return `${pad}- ${inlineMap(map)}`
          return entries
            .map(([k, v], i) => `${pad}${i === 0 ? '- ' : '  '}${k}:${emit(v, indent + 4)}`)
            .join('\n')
        })
        .join('\n')
    )
  }
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>
    const entries = Object.entries(map).filter(([, v]) => v !== undefined)
    if (!entries.length) return ' {}'
    if (indent > 0 && inlinable(map) && inlineMap(map).length < 72) return ` ${inlineMap(map)}`
    return '\n' + entries.map(([k, v]) => `${pad}${k}:${emit(v, indent + 2)}`).join('\n')
  }
  return ` ${yScalar(value)}`
}

export function emitPlaybooksYaml(root: Record<string, unknown>): string {
  return (
    [
      '# alethe-playbooks.yaml',
      '# The lead reads this file (scripts/orchestrate.py playbook) before it plans or delegates.',
      emit(root, 0).replace(/^\n/, ''),
    ].join('\n') + '\n'
  )
}

/**
 * Leading YAML frontmatter for the File preview's rendered markdown view.
 *
 * A deliberately small reader: it understands top-level keys only. Plain
 * and quoted scalars, block scalars (`|`, `>`) and flat string lists become
 * readable values; anything else (nested maps, anchors, tags, flow maps)
 * keeps its YAML source, so nothing in the file is ever hidden or mangled.
 */

export type FrontmatterValue =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'raw'; text: string }

export interface FrontmatterField {
  key: string
  value: FrontmatterValue
}

export interface ParsedFrontmatter {
  /** Top-level fields, or `null` when the block is not plain enough to tabulate. */
  fields: FrontmatterField[] | null
  /** The YAML between the fences, or `null` when the file has no frontmatter. */
  raw: string | null
  /** Markdown after the closing fence. */
  body: string
}

// Same detection the rendered view always used: `---` on line 1, closed by `---`.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s#\-'"][^:]*?|-[^\s:][^:]*?):(?:[ \t]+(.*))?$/
const BLOCK_SCALAR = /^([|>])([+-]?)\d*[+-]?$/

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FRONTMATTER.exec(text)
  if (!match) return { fields: null, raw: null, body: text }
  const raw = match[1]
  return { fields: parseFields(raw), raw, body: text.slice(match[0].length) }
}

function parseFields(raw: string): FrontmatterField[] | null {
  const lines = raw.split(/\r?\n/)
  const fields: FrontmatterField[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.startsWith('#')) {
      i++
      continue
    }
    const kv = KEY_LINE.exec(line)
    if (!kv) return null
    const key = unquote(kv[1])
    const rest = stripComment(kv[2] ?? '').trim()
    i++
    const block: string[] = []
    // A key's value continues over indented lines, blank lines, and (YAML
    // allows it) unindented `- item` lines under an empty key.
    while (i < lines.length) {
      const next = lines[i]
      if (!next.trim() || /^\s/.test(next) || (rest === '' && /^-(\s|$)/.test(next))) {
        block.push(next)
        i++
      } else break
    }
    while (block.length > 0 && !block[block.length - 1].trim()) block.pop()
    fields.push({ key, value: parseValue(rest, block) })
  }
  return fields
}

function parseValue(rest: string, block: string[]): FrontmatterValue {
  const scalar = BLOCK_SCALAR.exec(rest)
  if (scalar) return { kind: 'text', text: blockScalar(scalar[1] as '|' | '>', dedent(block)) }

  if (rest !== '') {
    if (/^[&*!{]/.test(rest)) return { kind: 'raw', text: [rest, ...dedent(block)].join('\n') }
    if (rest.startsWith('[')) {
      const items = block.length === 0 ? flowList(rest) : null
      return items ? { kind: 'list', items } : { kind: 'raw', text: [rest, ...dedent(block)].join('\n') }
    }
    // A plain or quoted scalar may wrap onto indented lines; YAML folds them.
    const joined = [rest, ...block.map((l) => l.trim()).filter(Boolean)].join(' ')
    return { kind: 'text', text: unquote(joined) }
  }

  const lines = dedent(block)
  if (lines.length === 0) return { kind: 'text', text: '' }
  const items: string[] = []
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const item = /^-(?:\s+(.*))?$/.exec(line)
    const value = item ? stripComment(item[1] ?? '').trim() : null
    if (value === null || /^[&*!{[|>]/.test(value) || KEY_LINE.test(value)) {
      return { kind: 'raw', text: lines.join('\n') }
    }
    items.push(unquote(value))
  }
  return { kind: 'list', items }
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length)
  const cut = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(Math.min(cut, /^\s*/.exec(l)![0].length)))
}

/** `|` keeps line breaks; `>` folds lines into paragraphs. */
function blockScalar(style: '|' | '>', lines: string[]): string {
  if (style === '|') return lines.join('\n')
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim()) current.push(line.trim())
    else if (current.length > 0) {
      paragraphs.push(current.join(' '))
      current = []
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs.join('\n')
}

/** `[a, "b", c]` → items, or `null` when it nests or is not closed. */
function flowList(text: string): string[] | null {
  if (!text.endsWith(']')) return null
  const inner = text.slice(1, -1)
  if (/[[\]{}]/.test(inner)) return null
  if (!inner.trim()) return []
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      items.push(unquote(current.trim()))
      current = ''
    } else current += ch
  }
  if (quote) return null
  if (current.trim()) items.push(unquote(current.trim()))
  return items
}

/** Drop a trailing ` # comment` that sits outside quotes. */
function stripComment(value: string): string {
  const t = value.trimStart()
  if (t.startsWith('"') || t.startsWith("'")) {
    const quote = t[0]
    let end = 1
    while (end < t.length) {
      if (quote === '"' && t[end] === '\\') end += 2
      else if (t[end] === quote && quote === "'" && t[end + 1] === "'") end += 2
      else if (t[end] === quote) break
      else end++
    }
    return t.slice(0, end + 1)
  }
  const hash = /\s#/.exec(value)
  return hash ? value.slice(0, hash.index) : value
}

function unquote(value: string): string {
  const t = value.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\/nt])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

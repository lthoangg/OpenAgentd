/**
 * Tiny frontmatter helpers for the agent editor.
 *
 * We intentionally hand-roll a minimal YAML serialiser instead of shipping a
 * JS yaml library, because the agent frontmatter we produce is a strict
 * subset: scalars + lists of strings. Anything more exotic (nested blocks,
 * arbitrary keys) is preserved verbatim in the raw body when the user drops
 * to the raw editor.
 */

export interface AgentFrontmatter {
  name: string
  role: 'lead' | 'member'
  description?: string | null
  model?: string | null
  temperature?: number | null
  thinking_level?: string | null
  tools?: string[]
  /** MCP server names; agent receives every tool from each listed server. */
  mcp?: string[]
}

const FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Split a raw .md file into ``(frontmatter_text, body)``. */
export function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { fm: '', body: raw }
  return { fm: m[1], body: m[2].replace(/^\r?\n/, '') }
}

/**
 * Serialise form fields into a canonical YAML frontmatter block. Skips
 * ``null`` / empty values so we don't emit ``description: null`` noise.
 */
export function buildFrontmatter(fm: AgentFrontmatter): string {
  const lines: string[] = []
  lines.push(`name: ${fm.name}`)
  lines.push(`role: ${fm.role}`)
  if (fm.description) lines.push(`description: ${escapeScalar(fm.description)}`)
  if (fm.model) lines.push(`model: ${fm.model}`)
  if (fm.temperature != null && !Number.isNaN(fm.temperature)) {
    lines.push(`temperature: ${fm.temperature}`)
  }
  if (fm.thinking_level) lines.push(`thinking_level: ${fm.thinking_level}`)
  // tools/skills are sets conceptually — order has no semantic meaning.
  // Emit them in sorted order so that reorders in the editor don't flip the
  // `dirty` flag and so saved files produce stable diffs.
  if (fm.tools && fm.tools.length > 0) {
    lines.push('tools:')
    for (const t of [...fm.tools].sort()) lines.push(`  - ${t}`)
  }
  if (fm.mcp && fm.mcp.length > 0) {
    lines.push('mcp:')
    for (const s of [...fm.mcp].sort()) lines.push(`  - ${s}`)
  }
  return lines.join('\n')
}

/** Combine frontmatter + body into a full .md file. */
export function combine(fm: AgentFrontmatter, body: string): string {
  return `---\n${buildFrontmatter(fm)}\n---\n\n${body.trim()}\n`
}

// ── Semantic equality ──────────────────────────────────────────────────────

/**
 * Return ``true`` when two raw .md files are *semantically* equal — i.e. the
 * only differences are list ordering (``tools``, ``skills``) and body
 * trailing whitespace.  Used by the editor's ``dirty`` check so that
 * toggling a tool off and back on does not light up the Save button.
 *
 * This is deliberately cheap and lossy: the parser only understands the
 * subset of YAML the form actually produces.  For anything more exotic
 * (comments, nested blocks, anchors) the comparison falls back to
 * byte-wise equality of the untouched portion via a whitespace-tolerant
 * body match plus a raw frontmatter equality guard.
 */
export function contentEquals(a: string, b: string): boolean {
  if (a === b) return true

  const sa = splitFrontmatter(a)
  const sb = splitFrontmatter(b)

  // Bodies must match modulo trailing whitespace.
  if (sa.body.replace(/\s+$/, '') !== sb.body.replace(/\s+$/, '')) {
    return false
  }

  // Parse frontmatter loosely and compare field-by-field with set semantics
  // for list fields.
  const pa = parseLooseYaml(sa.fm)
  const pb = parseLooseYaml(sb.fm)
  if (pa === null || pb === null) {
    // Either side contained something our parser refused to touch — fall
    // back to strict equality of the trimmed frontmatter block.
    return sa.fm.trim() === sb.fm.trim()
  }
  return yamlEquals(pa, pb)
}

function yamlEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const va = a[k]
    const vb = b[k]
    if (Array.isArray(va) && Array.isArray(vb)) {
      // Compare as sets of stringified elements. Order does not matter.
      if (va.length !== vb.length) return false
      const sa = [...va].map((x) => String(x)).sort()
      const sb = [...vb].map((x) => String(x)).sort()
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false
      continue
    }
    if (va !== vb) return false
  }
  return true
}

/**
 * Best-effort YAML parser for the subset the form produces (scalars + string
 * lists).  Returns ``null`` if any line looks like unsupported syntax
 * (nested objects, anchors, block scalars) so the caller can fall back to
 * strict equality.
 */
function parseLooseYaml(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let currentList: string[] | null = null

  for (const raw of lines) {
    // Strip trailing whitespace; ignore blank lines and comments.
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    const listMatch = /^\s+-\s+(.*)$/.exec(line)
    if (currentList && listMatch) {
      currentList.push(unquote(listMatch[1]))
      continue
    }

    const kvMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kvMatch) return null // bail — unsupported syntax

    const [, key, rawValue] = kvMatch
    currentList = null

    if (rawValue === '') {
      currentList = []
      out[key] = currentList
      continue
    }
    out[key] = coerceScalar(unquote(rawValue))
  }
  return out
}

function unquote(v: string): string {
  const t = v.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return t
}

function coerceScalar(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~' || v === '') return null
  const n = Number(v)
  if (!Number.isNaN(n) && v.trim() !== '') return n
  return v
}

/**
 * Quote a YAML scalar only when the raw text contains characters that
 * would confuse the parser (`:`, `#`, leading `-`, leading/trailing
 * whitespace). Unquoted form stays readable for common descriptions.
 */
function escapeScalar(v: string): string {
  const needsQuote =
    /[:#\n]/.test(v) ||
    /^[\s-!&*?|<>=%@`]/.test(v) ||
    /^\s|\s$/.test(v) ||
    v === '' ||
    ['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(v.toLowerCase())
  if (!needsQuote) return v
  // Use double quotes — escape backslashes and double quotes.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

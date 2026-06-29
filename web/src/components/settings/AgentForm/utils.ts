import { splitFrontmatter, type AgentFrontmatter } from '../frontmatter'

export const NORMAL_BUILT_IN_MEMBERS = new Set(['executor', 'explorer'])
export const CODING_BUILT_IN_MEMBERS = new Set(['coder', 'explorer'])

export function isBuiltInProfile(
  name?: string,
  role?: string | null,
  agentPath?: string,
): boolean {
  if (!name || !role) return false
  const path = agentPath ?? name
  const isCoding = path.startsWith('coding/')
  const basename = path.split('/').pop() ?? name
  if (role === 'lead') return basename === 'openagentd'
  if (role !== 'member') return false
  return isCoding
    ? CODING_BUILT_IN_MEMBERS.has(basename)
    : NORMAL_BUILT_IN_MEMBERS.has(basename)
}

// ── Model combobox ──────────────────────────────────────────────────────────

export function parseFormState(raw: string): {
  fm: AgentFrontmatter
  body: string
  error: string | null
} {
  const { fm: fmText, body } = splitFrontmatter(raw)
  const fm: AgentFrontmatter = { name: '', role: 'member' }

  if (!fmText.trim()) {
    return { fm, body, error: 'Missing YAML frontmatter (needs --- … --- header).' }
  }

  try {
    const parsed = parseSimpleYaml(fmText)
    if (typeof parsed.name === 'string') fm.name = parsed.name
    if (parsed.role === 'lead' || parsed.role === 'member') fm.role = parsed.role
    if (typeof parsed.description === 'string') fm.description = parsed.description
    if (typeof parsed.model === 'string') fm.model = parsed.model
    if (typeof parsed.temperature === 'number') fm.temperature = parsed.temperature
    if (typeof parsed.thinking_level === 'string') fm.thinking_level = parsed.thinking_level
    if (Array.isArray(parsed.tools)) fm.tools = parsed.tools.filter((x) => typeof x === 'string')
    if (Array.isArray(parsed.mcp)) fm.mcp = parsed.mcp.filter((x) => typeof x === 'string')
    return { fm, body, error: null }
  } catch (err) {
    return { fm, body, error: String((err as Error).message ?? err) }
  }
}

/**
 * Minimal YAML parser — handles the subset our AgentForm emits:
 * scalar key/values and bullet lists of strings. Anything more exotic
 * (nested objects, block scalars, anchors, flow style) is ignored
 * silently; the raw editor remains the escape hatch.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let currentList: string[] | null = null

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    // List continuation
    const listMatch = /^\s+-\s+(.*)$/.exec(line)
    if (currentList && listMatch) {
      currentList.push(unquote(listMatch[1]))
      continue
    }

    const kvMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kvMatch) {
      // Unknown indented content — skip gracefully.
      continue
    }
    const [, key, rawValue] = kvMatch
    currentList = null

    if (rawValue === '') {
      // Expect list on following lines.
      currentList = []
      out[key] = currentList
      continue
    }
    out[key] = coerce(unquote(rawValue))
  }
  return out
}

export function unquote(v: string): string {
  const t = v.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return t
}

export function coerce(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~' || v === '') return null
  const n = Number(v)
  if (!Number.isNaN(n) && v.trim() !== '') return n
  return v
}

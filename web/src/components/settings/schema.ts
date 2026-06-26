/**
 * Zod schemas for the settings editor.
 *
 * Mirrors the backend rules (``app/services/agent_fs.py`` +
 * ``app/agent/loader.py``) so the UI surfaces errors immediately, without a
 * round-trip.  The backend still validates independently on save — this is a
 * UX layer, not a trust boundary.
 *
 * Every exported schema has a matching ``validateXxx(raw)`` helper that
 * returns ``string | null`` (the first error message or ``null`` when
 * valid).  Helpers are preferred in rendering code because they avoid
 * dealing with ``SafeParseReturn`` objects in JSX.
 */
import { z } from 'zod'
import { splitFrontmatter } from './frontmatter'

z.config({ jitless: true })

// ── Primitive field schemas ──────────────────────────────────────────────────

/**
 * Agent / skill filename stem.  Matches
 * ``app/services/agent_fs.py::_NAME_RE`` byte-for-byte.
 */
export const agentNameSchema = z
  .string()
  .min(1, 'Required')
  .max(64, 'Max 64 characters')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    "Use letters, digits, '.', '_', '-' only (must start with a letter or digit)"
  )

/**
 * ``provider:model`` identifier.  Both halves must be non-empty; we do NOT
 * enforce a known-provider list here because the backend accepts custom
 * models (e.g. ``nvidia:custom-model``) and we don't want to block them.
 */
export const modelSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_-]+:[^\s]+$/,
    "Expected 'provider:model' (e.g. 'openai:gpt-5.4')"
  )

/** Sampling temperature. */
export const temperatureSchema = z
  .number()
  .min(0, 'Must be ≥ 0')
  .max(2, 'Must be ≤ 2')

/** Agent role — exactly one file in the team must be ``lead``. */
export const roleSchema = z.enum(['lead', 'member'])

/** Thinking level — empty string means "unset". */
export const thinkingLevelSchema = z.enum(['', 'none', 'low', 'medium', 'high'])

/** Short one-line description; empty string is allowed. */
export const descriptionSchema = z
  .string()
  .max(500, 'Max 500 characters')

// ── Skill field schemas ─────────────────────────────────────────────────────

/**
 * Skill filename/path. Supports flat names (``research``) and one nested level
 * (``git/commit``) to mirror ``app/services/agent_fs.py::_validate_skill_name``.
 */
export const skillNameSchema = z
  .string()
  .min(1, 'Required')
  .refine((value) => value.split('/').length <= 2, {
    message: "Only one nested level is allowed (e.g. 'parent/sub')",
  })
  .refine((value) => value.split('/').every((part) => agentNameSchema.safeParse(part).success), {
    message: "Each segment must use letters, digits, '.', '_', '-' and start with a letter or digit",
  })

/** Skill one-line description that the agent sees when browsing skills. */
export const skillDescriptionSchema = z
  .string()
  .min(1, 'Required — shown to agents when they browse skills')
  .max(500, 'Max 500 characters')

export const skillFrontmatterSchema = z.object({
  name: skillNameSchema,
  description: skillDescriptionSchema,
})

export type SkillFrontmatterParsed = z.infer<typeof skillFrontmatterSchema>

export function validateSkillForm(
  fm: unknown
): Record<string, string> | null {
  const result = skillFrontmatterSchema.safeParse(fm)
  if (result.success) return null
  const errors: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_root'
    if (!(path in errors)) errors[path] = issue.message
  }
  return errors
}

// ── Composite schema (whole frontmatter) ─────────────────────────────────────

/**
 * Shape of the agent form — keep in sync with
 * ``frontmatter.ts::AgentFrontmatter``.
 *
 * ``model`` is required (every agent needs one). Everything else is
 * optional/nullable to accommodate the "unset" UI state.
 */
export const agentFrontmatterSchema = z.object({
  name: agentNameSchema,
  role: roleSchema,
  description: descriptionSchema.nullable().optional(),
  model: modelSchema,
  temperature: temperatureSchema.nullable().optional(),
  thinking_level: thinkingLevelSchema.nullable().optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcp: z.array(z.string()).optional(),
})

export type AgentFrontmatterParsed = z.infer<typeof agentFrontmatterSchema>

/**
 * Full-form validation — returns a map of ``{ field → error message }``
 * for the fields that fail, or ``null`` if every field is valid.
 * Called by editor pages right before Save.
 */
export function validateAgentForm(
  fm: unknown
): Record<string, string> | null {
  const result = agentFrontmatterSchema.safeParse(fm)
  if (result.success) return null
  const errors: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_root'
    // Keep the first error per field.
    if (!(path in errors)) errors[path] = issue.message
  }
  return errors
}

// ── Single-field helpers (UX-friendly) ───────────────────────────────────────

/**
 * Return the first validation error for ``raw`` or ``null`` when valid.
 * Generic over any zod schema — used by the ``Field`` wrapper to show
 * inline messages underneath the control.
 */
export function firstError<T>(schema: z.ZodType<T>, raw: unknown): string | null {
  const r = schema.safeParse(raw)
  return r.success ? null : (r.error.issues[0]?.message ?? 'Invalid')
}

export function validateAgentName(raw: string): string | null {
  return firstError(agentNameSchema, raw)
}

export function validateModel(
  raw: string,
  opts: { required?: boolean; validValues?: readonly string[] } = {}
): string | null {
  if (!raw) return opts.required ? 'Required' : null
  const shape = firstError(modelSchema, raw)
  if (shape) return shape
  // If the caller supplied the list of known registry models, reject any
  // value that isn't one of them. (The list is omitted while the registry
  // is loading, in which case we only enforce the shape.)
  if (opts.validValues && opts.validValues.length > 0 && !opts.validValues.includes(raw)) {
    return 'Not in the provider model list'
  }
  return null
}

export function validateDescription(raw: string): string | null {
  if (!raw) return null // empty is fine
  return firstError(descriptionSchema, raw)
}

/**
 * Parse a user-typed temperature string into ``number | null``.
 *
 * Returns a discriminated union:
 *   - empty string → ``{ ok: true, value: null }``
 *   - valid in-range decimal → ``{ ok: true, value: <number> }``
 *   - intermediate state (``'0.'``, ``'.'``, ``'-'``) → ``{ ok: 'pending' }``
 *     so the caller keeps the raw string in state without flagging an
 *     error yet.
 *   - invalid → ``{ ok: false, error: '<msg>' }``
 */
export type TempParse =
  | { ok: true; value: number | null }
  | { ok: 'pending' }
  | { ok: false; error: string }

// ── Whole-draft validators ──────────────────────────────────────────────────

/**
 * Validate a raw ``.md`` draft (frontmatter + body) against the agent schema.
 * Returns ``null`` if valid, or a ``{ field → message }`` map for the first
 * error encountered per field.  A missing / malformed frontmatter returns
 * ``{ _root: '<parser message>' }``.
 */
export function validateAgentDraft(raw: string): Record<string, string> | null {
  const { fm: fmText } = splitFrontmatter(raw)
  if (!fmText.trim()) {
    return { _root: 'Missing YAML frontmatter (needs --- … --- header).' }
  }
  let fm: Record<string, unknown>
  try {
    fm = parseLooseYaml(fmText)
  } catch (err) {
    return { _root: (err as Error).message }
  }
  // The schema is strict about ``name`` and ``model`` being present.
  return validateAgentForm(fm)
}

/** Same for skills. */
export function validateSkillDraft(raw: string): Record<string, string> | null {
  const { fm: fmText } = splitFrontmatter(raw)
  if (!fmText.trim()) {
    return { _root: 'Missing YAML frontmatter (needs --- … --- header).' }
  }
  let fm: Record<string, unknown>
  try {
    fm = parseLooseYaml(fmText)
  } catch (err) {
    return { _root: (err as Error).message }
  }
  return validateSkillForm(fm)
}

/**
 * Minimal YAML parser — handles scalars, string lists, and the ``name:``
 * / ``description:`` header we care about.  Mirrors the parser in
 * ``AgentForm.parseSimpleYaml`` but without the form-specific type coercion.
 */
function parseLooseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let currentList: string[] | null = null

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    const listMatch = /^\s+-\s+(.*)$/.exec(line)
    if (currentList && listMatch) {
      currentList.push(unquote(listMatch[1]))
      continue
    }

    const kvMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kvMatch) continue
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
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
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

// ── Temperature input parser ───────────────────────────────────────────────

export function parseTemperatureInput(raw: string): TempParse {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }

  // Intermediate typing states — not yet a number, but don't reject.
  if (trimmed === '-' || trimmed === '.' || trimmed === '-.') {
    return { ok: 'pending' }
  }

  if (!/^-?\d*\.?\d*$/.test(trimmed)) {
    return { ok: false, error: 'Not a number' }
  }

  const n = Number(trimmed)
  if (Number.isNaN(n)) return { ok: false, error: 'Not a number' }

  const result = temperatureSchema.safeParse(n)
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid' }
  }
  return { ok: true, value: result.data }
}

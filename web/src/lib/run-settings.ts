/**
 * How the next message runs — model, thinking level, account — as the run
 * deck and the run picker show it. Pure helpers: labels, the recent-model
 * list, and the frontmatter edit behind "Make default".
 */
import type { ProviderInfo, ProviderUsageResponse, StoredCredential } from '@/api/client'

/** `provider:model` split for display; an id without a provider keeps it all as the model. */
export function splitModelId(id: string): { provider: string; model: string } {
  const at = id.indexOf(':')
  if (at <= 0) return { provider: '', model: id }
  return { provider: id.slice(0, at), model: id.slice(at + 1) }
}

const LEVEL_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** Short name for a thinking level (`high` → "High", `x-high` → "X High"). */
export function thinkingLevelLabel(level: string): string {
  return LEVEL_LABELS[level] ?? level.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
}

// ── What runs ───────────────────────────────────────────────────────────────

export interface RunChoice {
  model: string | null
  thinkingLevel: string | null
}

/**
 * The model and level the next message runs with. Mirrors the backend: a
 * session model of its own builds its own provider, which carries only the
 * session's level, never the agent's.
 */
export function effectiveRun(session: RunChoice, agent: RunChoice): RunChoice & { overridden: boolean } {
  const overridden = Boolean(session.model) && session.model !== agent.model
  return {
    model: session.model || agent.model || null,
    thinkingLevel: session.thinkingLevel || (overridden ? null : agent.thinkingLevel) || null,
    overridden,
  }
}

/** One level up or down (←/→ in the picker), stopping at either end. */
export function stepThinkingLevel(levels: readonly string[], current: string | null, direction: 1 | -1): string | null {
  if (levels.length === 0) return current
  const at = current ? levels.indexOf(current) : -1
  if (at < 0) return levels[0]
  return levels[Math.min(levels.length - 1, Math.max(0, at + direction))]
}

/**
 * The accounts a session can be pinned to, in the order they are tried; `null`
 * when there is nothing to choose (one account, a single-key provider, or a
 * key exported in the server's environment, which overrides the stored ones).
 */
export function accountChoices(provider: ProviderInfo | undefined): StoredCredential[] | null {
  if (!provider || provider.env_pinned || provider.supports_multiple_credentials === false) return null
  const enabled = (provider.stored_credentials ?? []).filter((c) => !c.disabled)
  return enabled.length >= 2 ? enabled : null
}

/** Percent left in the tightest usage window, or `null` when the provider reports none. */
export function quotaLeftPercent(usage: ProviderUsageResponse | undefined): number | null {
  let used: number | null = null
  for (const limit of usage?.limits ?? []) {
    for (const window of [limit.primary, limit.secondary]) {
      if (window && Number.isFinite(window.used_percent)) used = Math.max(used ?? 0, window.used_percent)
    }
  }
  return used === null ? null : Math.max(0, Math.round(100 - used))
}

// ── Recent models ───────────────────────────────────────────────────────────

const RECENT_KEY = 'oa.recentModels.v1'
const RECENT_MAX = 5

export function loadRecentModels(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

/** Move `id` to the front of the recent list (most recent first, five kept). */
export function rememberRecentModel(id: string): string[] {
  const next = [id, ...loadRecentModels().filter((m) => m !== id)].slice(0, RECENT_MAX)
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // A full or blocked storage only loses the shortcut list.
  }
  return next
}

// ── Make default ────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^(\s*---\r?\n)([\s\S]*?)(\r?\n---)/

/**
 * Set (or, with `null`, remove) top-level scalar keys in an agent file's
 * frontmatter, leaving every other line as it was. Keys that are missing
 * are added at the end of the block.
 */
export function setFrontmatterScalars(raw: string, values: Record<string, string | null>): string {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return raw
  const lines = m[2].split(/\r?\n/)
  const pending = new Map(Object.entries(values))
  const out: string[] = []
  for (const line of lines) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1]
    if (key && pending.has(key)) {
      const value = pending.get(key)
      pending.delete(key)
      if (value) out.push(`${key}: ${value}`)
      continue
    }
    out.push(line)
  }
  for (const [key, value] of pending) if (value) out.push(`${key}: ${value}`)
  return `${m[1]}${out.join('\n')}${m[3]}${raw.slice(m[0].length)}`
}

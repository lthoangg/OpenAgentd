/**
 * How the next message runs — model, thinking level, account — as the run
 * deck and the run picker show it. Pure helpers: labels, the recent-model
 * list, and the frontmatter edit behind "Make default".
 */
import type { ProviderInfo, ProviderUsageLimit, ProviderUsageResponse, StoredCredential } from '@/api/client'
import { formatUsageAmount } from '@/lib/usage-format'

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

/** Where a word or two must fit (a thinking segment, the run chip): "Extra high" is twice its neighbours' width. */
const SHORT_LEVEL_LABELS: Record<string, string> = {
  xhigh: 'XHigh',
}

/** A thinking level's name for a narrow slot; screen readers still hear {@link thinkingLevelLabel}. */
export function thinkingLevelShortLabel(level: string): string {
  return SHORT_LEVEL_LABELS[level] ?? thinkingLevelLabel(level)
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

export type QuotaTone = 'muted' | 'warning' | 'error'

/**
 * What is left of an account's quota, in one short phrase for a picker row.
 * `detail` carries what the phrase leaves out (a balance, a spend cap) for the
 * row's tooltip.
 */
export type QuotaSummary =
  | { kind: 'percent'; left: number; tone: QuotaTone; detail?: string; note?: string }
  | { kind: 'spend' | 'credits'; text: string; tone: QuotaTone; detail?: string }

type Spend = NonNullable<ProviderUsageLimit['spend']>
type Credits = NonNullable<ProviderUsageLimit['credits']>

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)
const percentLeft = (used: number) => Math.max(0, Math.round(100 - used))
/** A bare amount (`$84.50`, `12`): reads as "left". Ratios and notes (`237/300`, `12.40 used`) stay as given. */
const AMOUNT_RE = /^[^\d/\s]{0,3}\d[\d,]*(\.\d+)?$/

interface SpendReading {
  text: string
  tone: QuotaTone
  /** Percent of the cap left, unrounded; `null` when unknown. */
  leftPercent: number | null
}

function readSpend(spend: Spend): SpendReading | null {
  const limit = finite(spend.limit) && spend.limit > 0 ? spend.limit : null
  const remaining = finite(spend.remaining)
    ? spend.remaining
    : limit !== null && finite(spend.used)
      ? Math.max(0, limit - spend.used)
      : null
  const used = finite(spend.used_percent)
    ? spend.used_percent
    : limit !== null && finite(spend.used)
      ? (spend.used / limit) * 100
      : limit !== null && remaining !== null
        ? (1 - remaining / limit) * 100
        : null
  const fmt = (n: number) => formatUsageAmount(n, spend.currency)
  const text = limit !== null && remaining !== null ? `${fmt(remaining)} of ${fmt(limit)} left` : used !== null ? `${percentLeft(used)}% left` : null
  if (text === null) return null
  const spent = (remaining !== null && remaining <= 0) || (used !== null && used >= 100)
  return { text, tone: spent ? 'error' : used !== null && used >= 90 ? 'warning' : 'muted', leftPercent: used === null ? null : 100 - used }
}

function readCredits(credits: Credits): { text: string; tone: QuotaTone } {
  const balance = credits.balance?.trim() || null
  if (credits.unlimited) return { text: balance ?? 'Unlimited', tone: 'muted' }
  if (!credits.has_credits) return { text: 'No credits left', tone: 'error' }
  if (balance) return { text: AMOUNT_RE.test(balance) ? `${balance} left` : balance, tone: 'muted' }
  return { text: 'Credits available', tone: 'muted' }
}

/**
 * The tightest thing known about an account's quota, or `null` when nothing is.
 *
 * A reached spend cap leads unless a percent window still has room: then the
 * plan's windows still run the account and only its credits are spent, so the
 * window leads with a "no credits" note. Next comes whichever of a spend cap
 * and the percent windows has less left, then credits. Empty credits lead only
 * when there is nothing else: plans without credits report none, beside
 * windows that still have room.
 */
export function quotaSummary(usage: ProviderUsageResponse | undefined): QuotaSummary | null {
  const limits = usage?.limits ?? []

  let windowUsed: number | null = null
  for (const limit of limits) {
    for (const window of [limit.primary, limit.secondary]) {
      if (window && Number.isFinite(window.used_percent)) windowUsed = Math.max(windowUsed ?? 0, window.used_percent)
    }
  }

  const reached = limits.some((limit) => limit.spend?.reached)
  let spend: SpendReading | null = null
  for (const limit of limits) {
    const reading = limit.spend ? readSpend(limit.spend) : null
    if (reading && (!spend || (reading.leftPercent ?? 100) < (spend.leftPercent ?? 100))) spend = reading
  }

  const credits = limits.flatMap((limit) => (limit.credits ? [{ credits: limit.credits, ...readCredits(limit.credits) }] : []))
  const credit = credits.find((c) => c.tone === 'error') ?? credits.find((c) => c.credits.balance || c.credits.unlimited) ?? credits[0] ?? null

  // Empty credits say nothing a row beside a spend cap or a window needs.
  const creditBalance = credit?.credits.balance?.trim()
  const creditDetail = !credit || credit.tone === 'error' ? null : creditBalance ? `Balance ${creditBalance}` : credit.credits.unlimited ? 'Unlimited credits' : null
  const detailOf = (...parts: (string | null | undefined)[]) => {
    const text = parts.filter(Boolean).join(' · ')
    return text ? { detail: text } : {}
  }

  const windowLeft = windowUsed === null ? null : 100 - windowUsed
  if (reached && windowUsed !== null && windowUsed < 100) {
    return { kind: 'percent', left: percentLeft(windowUsed), tone: 'warning', note: 'no credits', detail: 'Spend cap reached' }
  }
  if (reached) return { kind: 'spend', text: 'Limit reached', tone: 'error', ...detailOf(creditDetail) }
  if (spend && (windowLeft === null || (spend.leftPercent !== null && spend.leftPercent < windowLeft))) {
    return { kind: 'spend', text: spend.text, tone: spend.tone, ...detailOf(creditDetail) }
  }
  if (windowUsed !== null) {
    return { kind: 'percent', left: percentLeft(windowUsed), tone: 'muted', ...detailOf(spend && `Spend cap ${spend.text}`, creditDetail) }
  }
  if (credit) return { kind: 'credits', text: credit.text, tone: credit.tone }
  return null
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

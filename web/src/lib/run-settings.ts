/**
 * How the next message runs — model, thinking level, account — as the run
 * deck and the run picker show it. Pure helpers: labels, the recent-model
 * list, and the frontmatter edit behind "Make default".
 */
import type { ProviderInfo, ProviderUsageLimit, ProviderUsageResponse, StoredCredential } from '@/api/client'
import { formatUsageAmount } from '@/lib/usage-format'
import { windowLabel } from '@/tray/providerView'
import { formatResetIn } from '@/tray/usage'

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

/** An account a request can go to now. */
const usable = (c: StoredCredential) => c.status === 'ready'

/**
 * The account a session runs on, for the run chip and the picker. A locked
 * account while it has room; else the one that last answered (`servedLabel`,
 * the newest account a turn or a switch named) or the provider's account in
 * use, whichever has room; else the first account with room. With every
 * account limited, the lock or the provider's choice, as the next request
 * waits for it.
 */
export function accountInUse(
  accounts: StoredCredential[] | null,
  lockedId: string | null,
  servedLabel: string | null,
): StoredCredential | null {
  if (!accounts || accounts.length === 0) return null
  const locked = lockedId ? accounts.find((c) => c.id === lockedId) ?? null : null
  const served = servedLabel ? accounts.find((c) => c.label === servedLabel) ?? null : null
  const shared = accounts.find((c) => c.in_use) ?? null
  // Unlocked, the next request goes to the provider's shared choice; a lock
  // that fell through stays on the account the session moved to.
  const order = locked ? [locked, served, shared] : [shared, served]
  return order.find((c): c is StoredCredential => c !== null && usable(c))
    ?? accounts.find(usable)
    ?? locked ?? shared ?? served ?? accounts[0]
}

export type QuotaTone = 'muted' | 'warning' | 'error'

/** One limit of an account, as a picker row shows it: `5h 12%`, `$8.20 of $50 used`. */
export interface QuotaSegment {
  text: string
  tone: QuotaTone
  /** The long form for the row's tooltip, with its reset time when known. */
  detail: string
}

/** An account's limits for a picker row, and the tooltip that spells them out. */
export interface QuotaSegments {
  segments: QuotaSegment[]
  /** Every segment's long form, then the limits the row leaves out (another model's). */
  detail: string
}

type Spend = NonNullable<ProviderUsageLimit['spend']>
type Credits = NonNullable<ProviderUsageLimit['credits']>
type Window = NonNullable<ProviderUsageLimit['primary']>

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)
/** A bare amount (`$84.50`, `12`): reads as "left". Ratios and notes (`237/300`, `12.40 used`) stay as given. */
const AMOUNT_RE = /^[^\d/\s]{0,3}\d[\d,]*(\.\d+)?$/

/** At or past the limit: red. Close to it: orange. As Settings → Providers colours its bars. */
const toneOf = (used: number): QuotaTone => (used >= 100 ? 'error' : used >= 90 ? 'warning' : 'muted')

/** A real but sub-percent use reads "<1%", never a false "0%". */
const percent = (used: number) => (used > 0 && used < 1 ? '<1%' : `${Math.round(Math.min(Math.max(used, 0), 100))}%`)

/** A window as a picker row names it: `5h`, `7d`, `30m`. */
export function shortWindowLabel(minutes?: number | null): string | null {
  if (typeof minutes !== 'number' || minutes <= 0) return null
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

const resetNote = (resetsAt: number | null | undefined, now: number) => {
  const text = formatResetIn(resetsAt, now)
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : null
}

function windowSegment(window: Window, now: number, name?: string | null): QuotaSegment | null {
  if (!finite(window.used_percent)) return null
  const short = shortWindowLabel(window.window_minutes)
  const long = windowLabel(window.window_minutes)
  const used = window.used_percent
  const reached = used >= 100
  const head = [name, long ? `${long} limit` : 'Limit'].filter(Boolean).join(' ')
  return {
    text: short ? `${short} ${percent(used)}` : percent(used),
    tone: toneOf(used),
    detail: [reached ? `${head} reached` : `${head} ${percent(used)} used`, resetNote(window.resets_at, now)].filter(Boolean).join(', '),
  }
}

function spendSegment(spend: Spend, now: number): QuotaSegment | null {
  const limit = finite(spend.limit) && spend.limit > 0 ? spend.limit : null
  const spent = finite(spend.used)
    ? spend.used
    : limit !== null && finite(spend.remaining)
      ? Math.max(0, limit - spend.remaining)
      : null
  const used = finite(spend.used_percent)
    ? spend.used_percent
    : limit !== null && spent !== null
      ? (spent / limit) * 100
      : null
  const fmt = (n: number) => formatUsageAmount(n, spend.currency)
  const text = limit !== null && spent !== null ? `${fmt(spent)} of ${fmt(limit)} used` : used !== null ? `Spend ${percent(used)}` : null
  if (text === null) return null
  const tone = spend.reached ? 'error' : toneOf(used ?? 0)
  const head = spend.reached || (used ?? 0) >= 100 ? 'Spend cap reached' : `Spend cap ${text}`
  return { text, tone, detail: [head, resetNote(spend.resets_at, now)].filter(Boolean).join(', ') }
}

function creditsText(credits: Credits): { text: string; empty: boolean } {
  const balance = credits.balance?.trim() || null
  if (credits.unlimited) return { text: balance ?? 'Unlimited', empty: false }
  if (!credits.has_credits) return { text: 'No credits left', empty: true }
  if (balance) return { text: AMOUNT_RE.test(balance) ? `${balance} left` : balance, empty: false }
  return { text: 'Credits available', empty: false }
}

/**
 * Every limit of an account worth a glance, in the order Settings → Providers
 * lists them, or `null` when nothing is known.
 *
 * - The windows of the account's main limit (the first): `5h 12% · 7d 64%`.
 *   Other limits' windows belong to one model (Codex Spark) and go in the
 *   tooltip, so one model's limit never makes the account look spent.
 * - A spend cap with figures, from any limit.
 * - Credits: a balance or unlimited credits. Empty credits only when they
 *   say something: there are no windows, or a cap was reached (plans without
 *   credits report none beside windows with room). While a window still has
 *   room the account runs on, so empty credits are orange, not red.
 * - A reached cap with no figures and no credits reads "Limit reached".
 *
 * A segment at its limit is red, one at 90% or more orange.
 */
export function quotaSegments(usage: ProviderUsageResponse | undefined, now = Date.now()): QuotaSegments | null {
  const limits = usage?.limits ?? []
  if (limits.length === 0) return null
  const [main, ...rest] = limits

  const windows = [main.primary, main.secondary]
    .map((w) => (w ? windowSegment(w, now) : null))
    .filter((s): s is QuotaSegment => s !== null)
  const windowRoom = windows.length > 0 && windows.every((s) => s.tone !== 'error')

  const spends = limits.flatMap((l) => (l.spend ? [spendSegment(l.spend, now)] : [])).filter((s): s is QuotaSegment => s !== null)
  const reached = limits.some((l) => l.spend?.reached)

  const credits = limits.flatMap((l) => (l.credits ? [creditsText(l.credits)] : []))
  const credit = credits.find((c) => c.empty) ?? credits.find((c) => c.text !== 'Credits available') ?? credits[0] ?? null
  const creditSegments: QuotaSegment[] = []
  if (credit) {
    if (credit.empty) {
      if (windows.length === 0 || reached) {
        creditSegments.push({ text: 'No credits left', tone: windowRoom ? 'warning' : 'error', detail: windowRoom ? 'No credits left; the plan limits still have room' : 'No credits left' })
      }
    } else if (credit.text !== 'Credits available' || (windows.length === 0 && spends.length === 0)) {
      creditSegments.push({ text: credit.text, tone: 'muted', detail: `Credits: ${credit.text}` })
    }
  }

  const segments = [...windows, ...spends, ...creditSegments]
  if (reached && spends.length === 0 && creditSegments.length === 0) {
    segments.push({ text: 'Limit reached', tone: 'error', detail: 'Spend cap reached' })
  }
  if (segments.length === 0) return null

  // Other limits' windows (one model's own limit) only in the tooltip.
  const others = rest.flatMap((l) => [l.primary, l.secondary]
    .map((w) => (w ? windowSegment(w, now, l.limit_name || l.limit_id) : null))
    .filter((s): s is QuotaSegment => s !== null)
    .map((s) => s.detail))
  return { segments, detail: [...segments.map((s) => s.detail), ...others].join(' · ') }
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

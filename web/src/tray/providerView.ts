/**
 * What the tray shows for one provider, and for the whole popup. Pure, so
 * the labelling rules are tested without rendering.
 *
 * A provider is named once (its card, or its single row); its rows say
 * which limit they are: the quota window ("5-hour", "Weekly"), "Spend
 * cap", or a balance, prefixed by the limit's own name only when that
 * name says more than the provider's.
 */
import {
  type MeterTone,
  type TrayUsageItem,
  type TrayUsageLimit,
  type TrayUsageResult,
  type TrayUsageWindow,
  clampPercent,
  formatAmount,
  formatResetIn,
  meterTone,
} from './usage'

export interface MeterRow {
  key: string
  kind: 'meter'
  label: string
  percent: number
  tone: MeterTone
  reset: string | null
  /** Share of the quota window already gone (0–100), or null when unknown. */
  nowLine: number | null
  detail?: string
  reached: boolean
}

export interface ValueRow {
  key: string
  kind: 'value'
  label: string
  value: string
  tone: MeterTone
}

export type Row = MeterRow | ValueRow

export interface ProviderView {
  key: string
  name: string
  /** Plan tier, capitalised ("Plus"), when the provider reports one. */
  plan: string | null
  stale: boolean
  /** Worst tone across the rows. */
  tone: MeterTone
  /** A limit is used up (100%, a reached cap, or no credits left). */
  reached: boolean
  /** Set instead of rows when there is nothing to measure. */
  status: 'reconnect' | 'unavailable' | 'no-data' | null
  rows: Row[]
}

const TONE_RANK: Record<MeterTone, number> = { ok: 0, warn: 1, crit: 2 }

function worst(tones: MeterTone[]): MeterTone {
  return tones.reduce<MeterTone>((a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a), 'ok')
}

/** The window as people say it: "5-hour", "Daily", "Weekly", "Monthly". */
export function windowLabel(minutes?: number | null): string | null {
  if (typeof minutes !== 'number' || minutes <= 0) return null
  if (minutes === 1440) return 'Daily'
  if (minutes === 10_080) return 'Weekly'
  if (minutes >= 40_320 && minutes <= 44_640) return 'Monthly'
  if (minutes < 60) return `${minutes}-minute`
  if (minutes < 1440) return `${Math.round(minutes / 60)}-hour`
  return `${Math.round(minutes / 1440)}-day`
}

/**
 * The part of a limit's name the provider's name doesn't already say:
 * "Codex" under "OpenAI Codex" adds nothing, "DeepSeek Balance" under
 * "DeepSeek" adds "Balance", "On-demand cap" under "Grok" is kept whole.
 */
function ownName(provider: string, limitName?: string | null): string | null {
  const name = limitName?.trim() ?? ''
  if (!name || provider.includes(name)) return null
  if (name.includes(provider)) return name.replace(provider, '').trim() || null
  return name
}

function joinLabel(...parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part))
  return kept.length > 0 ? kept.join(' · ') : null
}

/**
 * Where the wall clock sits in the quota window (0–100): from
 * ``resets_at`` and ``window_minutes`` for a rolling window, else from an
 * explicit period. Null when neither pins a start.
 */
function nowLinePosition(
  window: TrayUsageWindow | null,
  periodStart: number | null | undefined,
  periodEnd: number | null | undefined,
  now: number,
): number | null {
  if (window && typeof window.resets_at === 'number' && typeof window.window_minutes === 'number' && window.window_minutes > 0) {
    const total = window.window_minutes * 60
    return clampPercent(((now - (window.resets_at - total)) / total) * 100)
  }
  if (typeof periodStart === 'number' && typeof periodEnd === 'number' && periodEnd > periodStart) {
    return clampPercent(((now - periodStart) / (periodEnd - periodStart)) * 100)
  }
  return null
}

function windowRow(key: string, limit: TrayUsageLimit, window: TrayUsageWindow, own: string | null, now: number): MeterRow {
  const percent = window.used_percent
  return {
    key,
    kind: 'meter',
    label: joinLabel(own, windowLabel(window.window_minutes)) ?? 'Usage',
    percent,
    tone: meterTone(percent),
    reset: formatResetIn(window.resets_at),
    nowLine: nowLinePosition(window, limit.period_start_at, limit.period_end_at, now),
    reached: percent >= 100,
  }
}

function spendRow(key: string, limit: TrayUsageLimit, own: string | null, now: number): MeterRow {
  const spend = limit.spend!
  const percent = typeof spend.used_percent === 'number'
    ? spend.used_percent
    : typeof spend.used === 'number' && typeof spend.limit === 'number' && spend.limit > 0
      ? (spend.used / spend.limit) * 100
      : 0
  const detail = typeof spend.used === 'number' && typeof spend.limit === 'number'
    ? `${formatAmount(spend.used)} of ${formatAmount(spend.limit)} used${
        typeof spend.remaining === 'number' && spend.remaining > 0 ? ` · ${formatAmount(spend.remaining)} left` : ''
      }`
    : undefined
  return {
    key,
    kind: 'meter',
    label: joinLabel(own, 'Spend cap')!,
    percent,
    tone: spend.reached ? 'crit' : meterTone(percent),
    reset: formatResetIn(spend.resets_at),
    nowLine: nowLinePosition(null, limit.period_start_at, limit.period_end_at, now),
    detail,
    reached: spend.reached || percent >= 100,
  }
}

function limitRows(item: TrayUsageItem, limit: TrayUsageLimit, index: number, now: number): Row[] {
  const key = `${item.provider}-${index}`
  const own = ownName(item.label, limit.limit_name)
  const spend = limit.spend
  const hasSpend = typeof spend?.limit === 'number' || typeof spend?.used === 'number' || typeof spend?.used_percent === 'number'
  const rows: Row[] = []
  if (limit.primary) rows.push(windowRow(`${key}-p`, limit, limit.primary, own, now))
  if (limit.secondary) rows.push(windowRow(`${key}-s`, limit, limit.secondary, own, now))
  if (hasSpend) rows.push(spendRow(`${key}-spend`, limit, own, now))
  // Credits are the signal when there are no quota windows (DeepSeek and
  // OpenRouter balances); a reached spend cap outranks them.
  if (limit.credits && !limit.primary && !limit.secondary) {
    const reached = Boolean(limit.spend?.reached)
    const value = reached
      ? 'Limit reached'
      : limit.credits.unlimited
        ? (limit.credits.balance ?? 'Unlimited')
        : limit.credits.has_credits
          ? (limit.credits.balance ?? 'Available')
          : 'None left'
    rows.push({
      key: `${key}-credits`,
      kind: 'value',
      label: own ?? (limit.credits.balance ? 'Balance' : 'Credits'),
      value,
      tone: reached || !limit.credits.has_credits ? 'crit' : 'ok',
    })
  }
  if (!limit.primary && !limit.secondary && !hasSpend && !limit.credits
    && (typeof limit.period_start_at === 'number' || typeof limit.period_end_at === 'number')) {
    rows.push({ key: `${key}-period`, kind: 'value', label: own ?? 'Period', value: formatResetIn(limit.period_end_at) ?? 'Active', tone: 'ok' })
  }
  return rows
}

function capitalise(text: string | null | undefined): string | null {
  const value = text?.trim()
  return value ? value[0]!.toUpperCase() + value.slice(1) : null
}

export function providerView(item: TrayUsageItem, now: number = Date.now() / 1000): ProviderView {
  const base = { key: item.provider, name: item.label, stale: item.stale }
  const empty = (status: ProviderView['status']): ProviderView => ({ ...base, plan: null, tone: 'ok', reached: false, status, rows: [] })
  if (item.status === 'credentials_missing') return empty('reconnect')
  if (item.status === 'unavailable') return empty('unavailable')
  const limits = item.usage?.limits ?? []
  const rows = limits.flatMap((limit, index) => limitRows(item, limit, index, now))
  if (rows.length === 0) return empty('no-data')
  return {
    ...base,
    plan: capitalise(limits.find((limit) => limit.plan_type)?.plan_type),
    tone: worst(rows.map((row) => row.tone)),
    reached: rows.some((row) => (row.kind === 'meter' ? row.reached : row.tone === 'crit')),
    status: null,
    rows,
  }
}

export type TrayStatus = 'loading' | 'offline' | 'none' | 'ok' | 'warn' | 'crit' | 'reached'

export const TRAY_STATUS_LABEL: Record<TrayStatus, string> = {
  loading: 'Checking',
  offline: 'Offline',
  none: 'No providers',
  ok: 'Within limits',
  warn: 'Getting close',
  crit: 'Near limit',
  reached: 'Limit reached',
}

/**
 * The popup's headline. Offline only when there is nothing to show; a
 * failed refresh over a last reading keeps that reading's status.
 */
export function trayStatus(result: TrayUsageResult | null, loadError: string | null): TrayStatus {
  const summary = result?.summary
  if (!summary) return result?.error || loadError ? 'offline' : 'loading'
  const views = summary.items.map((item) => providerView(item))
  if (views.length === 0) return 'none'
  if (views.some((view) => view.reached)) return 'reached'
  return worst(views.map((view) => view.tone))
}

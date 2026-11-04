// Mirror of the schema returned by the Rust `get_tray_usage_summary` command
// (see desktop/src-tauri/src/usage.rs). Rust serializes `Option` as null, so
// every optional field is nullable here.

export interface TrayUsageWindow {
  used_percent: number
  window_minutes?: number | null
  resets_at?: number | null
}

export interface TrayUsageCredits {
  has_credits: boolean
  unlimited: boolean
  balance?: string | null
}

export interface TrayUsageSpend {
  reached: boolean
  limit?: number | null
  used?: number | null
  remaining?: number | null
  used_percent?: number | null
  resets_at?: number | null
}

export interface TrayUsageLimit {
  limit_id?: string | null
  limit_name?: string | null
  primary?: TrayUsageWindow | null
  secondary?: TrayUsageWindow | null
  credits?: TrayUsageCredits | null
  spend?: TrayUsageSpend | null
  plan_type?: string | null
  rate_limit_reached_type?: string | null
  period_start_at?: number | null
  period_end_at?: number | null
}

export interface TrayUsageResponse {
  provider: string
  limits: TrayUsageLimit[]
  /** When the backend last read these numbers (unix seconds); may be absent. */
  updated_at?: number | null
}

export interface TrayUsageItem {
  provider: string
  label: string
  /** Known: ok, credentials_missing, unavailable, rate_limited; others are tolerated. */
  status: string
  error?: string | null
  stale: boolean
  usage?: TrayUsageResponse | null
  /** Unix seconds before which a rate-limited provider should not be asked again. */
  retry_at?: number | null
  /** Seconds to wait as of the response; ``retry_at`` is preferred. */
  retry_after?: number | null
  /** The account whose limits these are, when the provider pools several. */
  account?: string | null
}

export interface TrayUsageSummary {
  items: TrayUsageItem[]
  checked_at: number
  cached: boolean
}

export interface TrayServerOption {
  id: string
  name: string
  detail?: string | null
}

export interface TrayUsageResult {
  summary?: TrayUsageSummary | null
  server_name: string
  server_id: string
  servers: TrayServerOption[]
  selected_server_id: string
  error?: string | null
}

export type MeterTone = 'ok' | 'warn' | 'crit'

/** Same thresholds as the native badge: <70 ok, 70-89 warn, >=90 critical. */
export function meterTone(percent: number): MeterTone {
  if (percent >= 90) return 'crit'
  if (percent >= 70) return 'warn'
  return 'ok'
}

export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent))
}

/** "Resets in 2h 05m" for a window's reset; also the Settings usage panel's. */
export function formatResetIn(resetsAt?: number | null, now = Date.now()): string | null {
  if (typeof resetsAt !== 'number') return null
  const remaining = resetsAt - now / 1000
  if (remaining <= 0) return 'Resetting now'
  const minutes = Math.round(remaining / 60)
  if (minutes < 1) return 'Resets in <1m'
  if (minutes < 60) return `Resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  if (hours < 24) return remMinutes === 0 ? `Resets in ${hours}h` : `Resets in ${hours}h ${remMinutes}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours === 0 ? `Resets in ${days}d` : `Resets in ${days}d ${remHours}h`
}

const amountFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export function formatAmount(value: number): string {
  return amountFormatter.format(value)
}

export function formatCheckedAt(checkedAt: number): string | null {
  if (!checkedAt) return null
  const age = Math.max(0, Math.floor((Date.now() / 1000 - checkedAt) / 60))
  if (age === 0) return 'Checked just now'
  if (age < 60) return `Checked ${age}m ago`
  return `Checked ${Math.floor(age / 60)}h ago`
}

/** "<1m" / "5m" / "2h 10m" / "3d" for a span in seconds (positive). */
export function formatSpan(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  if (hours < 24) return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Longer than this is not a retry time anyone can act on. */
const MAX_RETRY_SECONDS = 30 * 86_400

/**
 * When a rate-limited provider may be asked again. ``retry_at`` outranks
 * ``retry_after``; unusable timing is "later", an elapsed one "soon".
 */
export function formatRetry(item: Pick<TrayUsageItem, 'retry_at' | 'retry_after'>, now: number): string {
  const seconds = finite(item.retry_at) ? item.retry_at - now : finite(item.retry_after) ? item.retry_after : null
  if (seconds === null || seconds > MAX_RETRY_SECONDS) return 'Retry later'
  if (seconds <= 0) return 'Retrying soon'
  return `Retry in ${formatSpan(seconds)}`
}

/** "12m ago" for a unix-seconds timestamp; null when absent or unusable. */
export function formatAgo(timestamp: unknown, now: number): string | null {
  if (!finite(timestamp) || timestamp <= 0) return null
  const seconds = Math.max(0, now - timestamp)
  return seconds < 60 ? 'just now' : `${formatSpan(seconds)} ago`
}

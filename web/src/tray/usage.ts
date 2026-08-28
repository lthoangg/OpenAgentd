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
}

export interface TrayUsageItem {
  provider: string
  label: string
  status: string
  error?: string | null
  stale: boolean
  usage?: TrayUsageResponse | null
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

export function formatResetIn(resetsAt?: number | null): string | null {
  if (typeof resetsAt !== 'number') return null
  const remaining = resetsAt - Date.now() / 1000
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

export function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

export function formatCheckedAt(checkedAt: number): string | null {
  if (!checkedAt) return null
  const age = Math.max(0, Math.floor((Date.now() / 1000 - checkedAt) / 60))
  if (age === 0) return 'Checked just now'
  if (age < 60) return `Checked ${age}m ago`
  return `Checked ${Math.floor(age / 60)}h ago`
}

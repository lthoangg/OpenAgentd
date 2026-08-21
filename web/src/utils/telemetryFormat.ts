/**
 * Display helpers for the /telemetry page.
 *
 * Split out of `routes/telemetry.tsx` so the module only exports components
 * (required for React Fast Refresh) and so the helpers are easy to unit-test.
 */

import { formatFullDateTime } from '@/utils/format'

const intFmt = new Intl.NumberFormat('en-US')
const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
})

export function formatInt(n: number): string {
  return intFmt.format(n)
}

export function formatCompact(n: number): string {
  if (n < 1000) return intFmt.format(n)
  return compactFmt.format(n)
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '-'
  return usdFmt.format(n)
}

export function formatPercent(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0%'
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`
}

/**
 * Format a millisecond duration.  0 becomes a hyphen so empty cells read
 * cleanly in tables; sub-second values render as whole ms; values >=1s switch
 * to seconds with one decimal.
 */
export function formatMs(n: number): string {
  if (n === 0) return '-'
  if (n < 1000) return `${n.toFixed(0)} ms`
  return `${(n / 1000).toFixed(1)} s`
}

/**
 * Compact "5s ago" / "3m ago" label.  Pure function on (past, now) so tests
 * can pass an explicit `now` instead of freezing the clock.
 */
export function timeAgo(pastMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - pastMs)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return formatFullDateTime(new Date(pastMs)).split(' ')[0]
}

/**
 * Truncate long hex-ish ids for table cells: full id shows on hover.
 * Differs from `@/utils/format.shortId` by stripping the `0x` prefix and
 * adding a mid-ellipsis for very long values.
 */
export function formatShortId(id: string): string {
  const clean = id.startsWith('0x') ? id.slice(2) : id
  if (clean.length <= 12) return clean
  return `${clean.slice(0, 8)}…${clean.slice(-4)}`
}

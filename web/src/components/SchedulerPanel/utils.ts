import type { ScheduledTaskResponse } from '@/api/types'
import type { ChipTone } from '@/components/ui/chip'
import { formatInTimezone } from '@/utils/format'

export const FIELD_CLASS = 'bg-(--bg-page) dark:bg-(--bg-page)'

// Field text for the task forms (DESIGN.md → Panels and management surfaces):
// label 8px above the control, hint or error 8px below it.
export const FIELD_LABEL = 'mb-2 block text-xs font-medium text-(--color-text)'
export const FIELD_HINT = 'mt-2 text-[11px] leading-relaxed text-(--color-text-muted)'
export const FIELD_ERROR = 'mt-2 text-[11px] leading-relaxed text-(--color-error)'

// Inline className for SelectContent — the global default (`bg-popover`)
// resolves to `--bg-card`, the same surface as this drawer, so the dropdown
// looks like an outlined frame floating on the same paper. Use the page
// surface for clear contrast and soften the border.
export const SELECT_CONTENT_CLASS = 'bg-(--bg-page) border-(--color-border-strong)'
export const TASK_LONG_PRESS_MS = 520
export const TASK_LONG_PRESS_MOVE_TOLERANCE = 10

/** Interval units the forms offer, largest first. */
export const INTERVAL_UNITS = [
  { value: 'days', label: 'days', seconds: 86_400 },
  { value: 'hours', label: 'hours', seconds: 3_600 },
  { value: 'minutes', label: 'minutes', seconds: 60 },
  { value: 'seconds', label: 'seconds', seconds: 1 },
] as const
export type IntervalUnit = (typeof INTERVAL_UNITS)[number]['value']

/** Largest unit that divides ``seconds`` evenly: 3600 → 1 hours, 90 → 90 seconds. */
export function splitInterval(seconds: number): { amount: number; unit: IntervalUnit } {
  for (const u of INTERVAL_UNITS) {
    if (seconds > 0 && seconds % u.seconds === 0) return { amount: seconds / u.seconds, unit: u.value }
  }
  return { amount: Math.max(0, Math.round(seconds)), unit: 'seconds' }
}

/** "3 min", "1 h", "2 d", "90 s". */
export function formatInterval(seconds: number): string {
  const { amount, unit } = splitInterval(seconds)
  const short = { days: 'd', hours: 'h', minutes: 'min', seconds: 's' }[unit]
  return `${amount} ${short}`
}

/** The schedule in one short line: "every 3 min", "cron 0 9 * * 1-5", "once at 24/10/2026 09:00". */
export function formatScheduleLabel(task: Pick<ScheduledTaskResponse, 'schedule_type' | 'at_datetime' | 'every_seconds' | 'cron_expression' | 'timezone'>): string {
  if (task.schedule_type === 'at' && task.at_datetime) {
    // Render in the task's saved timezone, not the browser's — otherwise
    // a task scheduled for "9 AM in New York" displays a different time
    // when viewed from a Vietnam-based browser.
    return `once at ${formatInTimezone(task.at_datetime, task.timezone)}`
  }
  if (task.schedule_type === 'every' && task.every_seconds) {
    return `every ${formatInterval(task.every_seconds)}`
  }
  if (task.schedule_type === 'cron' && task.cron_expression) {
    return `cron ${task.cron_expression}`
  }
  return 'unknown schedule'
}

/**
 * What the task is doing, as one chip. The backend's ``pending`` means
 * "waiting for its next run", and ``failed`` on a repeating task only means
 * the last run failed: it still runs again.
 */
export function taskState(task: Pick<ScheduledTaskResponse, 'status' | 'enabled' | 'next_fire_at'>): { label: string; tone: ChipTone; dot?: boolean } {
  switch (task.status) {
    case 'running':
      return { label: 'running', tone: 'info', dot: true }
    case 'paused':
      return { label: 'paused', tone: 'warning' }
    case 'completed':
      return { label: 'done', tone: 'success' }
    case 'failed':
      return task.next_fire_at ? { label: 'last run failed', tone: 'error' } : { label: 'failed', tone: 'error' }
    case 'pending':
      return task.enabled ? { label: 'scheduled', tone: 'neutral' } : { label: 'paused', tone: 'warning' }
    default:
      return { label: task.status, tone: 'neutral' }
  }
}

function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / 60_000)
}

/** "now", "5m", "3h", "2d". */
function span(minutes: number): string {
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** "Last run 2m ago · ok", "Last run 1h ago · failed", "Not run yet". */
export function lastRunLabel(task: Pick<ScheduledTaskResponse, 'last_run_at' | 'last_error'>, now = Date.now()): string {
  if (!task.last_run_at) return 'Not run yet'
  const t = new Date(task.last_run_at).getTime()
  if (!Number.isFinite(t)) return 'Not run yet'
  const m = Math.max(0, minutesBetween(t, now))
  return `Last run ${m < 1 ? 'just now' : `${span(m)} ago`} · ${task.last_error ? 'failed' : 'ok'}`
}

/** "Next run in 1m", "Next run due now"; null when nothing is scheduled. */
export function nextRunLabel(task: Pick<ScheduledTaskResponse, 'next_fire_at'>, now = Date.now()): string | null {
  if (!task.next_fire_at) return null
  const t = new Date(task.next_fire_at).getTime()
  if (!Number.isFinite(t)) return null
  const m = minutesBetween(now, t)
  return m < 1 ? 'Next run due now' : `Next run in ${span(m)}`
}

// ── Mode / workspace shared bits ────────────────────────────────────────────

export function slugify(text: string): string {
  let slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[^a-z0-9._-]/g, '-')   // replace spaces & symbols with dashes
    .replace(/-+/g, '-')             // collapse multiple dashes
    .replace(/^[._-]+|[._-]+$/g, '') // trim leading/trailing dots, underscores, and dashes

  if (slug && !/^[a-z0-9]/.test(slug)) {
    slug = slug.replace(/^[^a-z0-9]+/, '')
  }

  return slug.substring(0, 64)
}

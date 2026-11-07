import type { ScheduledTaskResponse } from '@/api/types'
import { STATUS, type StatusView } from '@/lib/status'
import { formatCompactDate, formatInTimezone, wallClockToISO } from '@/utils/format'

export const FIELD_CLASS = 'bg-(--bg-page) dark:bg-(--bg-page)'

// Field text for the task forms (DESIGN.md → Panels and management surfaces):
// label 8px above the control, hint or error 8px below it.
export const FIELD_LABEL = 'mb-2 block text-xs font-medium text-(--color-text)'
export const FIELD_HINT = 'mt-2 text-meta leading-relaxed text-(--color-text-muted)'
export const FIELD_ERROR = 'mt-2 text-meta leading-relaxed text-(--color-error)'

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

/** The schedule in one short line: "every 3 min", "cron 0 9 * * 1-5", "once at Oct 24, 09:00". */
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
 * What the task is doing, as one chip in the shared vocabulary
 * (``lib/status``). The backend's ``pending`` means "waiting for its next
 * run", and ``failed`` on a repeating task only means the last run failed:
 * it still runs again.
 */
export function taskState(task: Pick<ScheduledTaskResponse, 'status' | 'enabled' | 'next_fire_at'>): StatusView {
  switch (task.status) {
    case 'running':
      return STATUS.running
    case 'paused':
      return STATUS.paused
    case 'completed':
      return STATUS.done
    case 'failed':
      return task.next_fire_at ? { label: 'Last run failed', tone: 'error' } : STATUS.failed
    case 'pending':
      return task.enabled ? STATUS.scheduled : STATUS.paused
    default:
      return { label: task.status, tone: 'neutral' }
  }
}

function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / 60_000)
}

const WEEK_MINUTES = 7 * 24 * 60

/** "5m", "3h", "2d": the list age steps (DESIGN.md → Dates), under a week. */
function span(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** "Last run 2m ago · ok", "Last run 1h ago · failed", "Last run Aug 22 · ok", "Not run yet". */
export function lastRunLabel(task: Pick<ScheduledTaskResponse, 'last_run_at' | 'last_error'>, now = Date.now()): string {
  if (!task.last_run_at) return 'Not run yet'
  const t = new Date(task.last_run_at).getTime()
  if (!Number.isFinite(t)) return 'Not run yet'
  const m = Math.max(0, minutesBetween(t, now))
  const when = m < 1 ? 'just now' : m < WEEK_MINUTES ? `${span(m)} ago` : formatCompactDate(new Date(t), new Date(now))
  return `Last run ${when} · ${task.last_error ? 'failed' : 'ok'}`
}

/** "Next run in 1m", "Next run due now", "Next run Aug 22"; null when nothing is scheduled. */
export function nextRunLabel(task: Pick<ScheduledTaskResponse, 'next_fire_at'>, now = Date.now()): string | null {
  if (!task.next_fire_at) return null
  const t = new Date(task.next_fire_at).getTime()
  if (!Number.isFinite(t)) return null
  const m = minutesBetween(now, t)
  if (m < 1) return 'Next run due now'
  return m < WEEK_MINUTES ? `Next run in ${span(m)}` : `Next run ${formatCompactDate(new Date(t), new Date(now))}`
}

/**
 * The one-time form's preview of a picked wall-clock time in ``timeZone``:
 * "Runs in 3h (Asia/Ho_Chi_Minh)", "Runs Nov 14 (UTC)", or, for a time
 * already gone (which the scheduler fires at once), the warning. Null with
 * nothing picked.
 */
export function atRunHint(wallClock: string, timeZone: string, now = Date.now()): { past: boolean; text: string } | null {
  if (!wallClock) return null
  const t = new Date(wallClockToISO(wallClock, timeZone)).getTime()
  if (!Number.isFinite(t)) return null
  const m = minutesBetween(now, t)
  if (m < 0) return { past: true, text: 'That time has passed: it runs as soon as you save.' }
  const when = m < 1 ? 'now' : m < WEEK_MINUTES ? `in ${span(m)}` : formatCompactDate(new Date(t), new Date(now))
  return { past: false, text: `Runs ${when} (${timeZone})` }
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

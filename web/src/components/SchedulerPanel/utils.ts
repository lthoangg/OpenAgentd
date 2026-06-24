import type { ScheduledTaskResponse } from '@/api/types'
import { formatInTimezone } from '@/utils/format'

export const FIELD_CLASS = 'bg-(--bg-page) dark:bg-(--bg-page)'

// Inline className for SelectContent — the global default (`bg-popover`)
// resolves to `--bg-card`, the same surface as this drawer, so the dropdown
// looks like an outlined frame floating on the same paper. Use the page
// surface for clear contrast and soften the border.
export const SELECT_CONTENT_CLASS = 'bg-(--bg-page) border-(--color-border-strong)'
export const TASK_LONG_PRESS_MS = 520
export const TASK_LONG_PRESS_MOVE_TOLERANCE = 10

// Three-option segmented control used for "Schedule type". The shared Tabs
// primitive inverts in light mode (track = bg-key which is darker than the
// active bg-background = bg-page), so we render a flat row of buttons that
// match the rest of this drawer's surfaces.
export function formatScheduleLabel(task: Pick<ScheduledTaskResponse, 'schedule_type' | 'at_datetime' | 'every_seconds' | 'cron_expression' | 'timezone'>): string {
  if (task.schedule_type === 'at' && task.at_datetime) {
    // Render in the task's saved timezone, not the browser's — otherwise
    // a task scheduled for "9 AM in New York" displays a different time
    // when viewed from a Vietnam-based browser.
    return `at ${formatInTimezone(task.at_datetime, task.timezone)}`
  }
  if (task.schedule_type === 'every' && task.every_seconds) {
    const mins = Math.floor(task.every_seconds / 60)
    const secs = task.every_seconds % 60
    if (mins > 0 && secs === 0) return `every ${mins}m`
    if (mins === 0) return `every ${secs}s`
    return `every ${mins}m ${secs}s`
  }
  if (task.schedule_type === 'cron' && task.cron_expression) {
    return `cron: ${task.cron_expression}`
  }
  return 'unknown schedule'
}

// ── Mode / workspace shared bits ────────────────────────────────────────────

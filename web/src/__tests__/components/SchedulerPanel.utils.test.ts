import { describe, expect, it } from 'bun:test'
import type { ScheduledTaskResponse } from '@/api/types'
import {
  INTERVAL_UNITS,
  formatInterval,
  formatScheduleLabel,
  lastRunLabel,
  nextRunLabel,
  splitInterval,
  taskState,
} from '@/components/SchedulerPanel/utils'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const ahead = (ms: number) => new Date(NOW + ms).toISOString()

describe('INTERVAL_UNITS', () => {
  it('offers days, hours, minutes and seconds, largest first', () => {
    expect(INTERVAL_UNITS.map((u) => [u.value, u.seconds])).toEqual([
      ['days', 86_400],
      ['hours', 3_600],
      ['minutes', 60],
      ['seconds', 1],
    ])
  })
})

describe('splitInterval', () => {
  it('uses the largest unit that divides the seconds evenly', () => {
    expect(splitInterval(3600)).toEqual({ amount: 1, unit: 'hours' })
    expect(splitInterval(7200)).toEqual({ amount: 2, unit: 'hours' })
    expect(splitInterval(86_400)).toEqual({ amount: 1, unit: 'days' })
    expect(splitInterval(172_800)).toEqual({ amount: 2, unit: 'days' })
    expect(splitInterval(180)).toEqual({ amount: 3, unit: 'minutes' })
    expect(splitInterval(90)).toEqual({ amount: 90, unit: 'seconds' })
    expect(splitInterval(45)).toEqual({ amount: 45, unit: 'seconds' })
  })

  it('falls back to seconds for zero or fractional input', () => {
    expect(splitInterval(0)).toEqual({ amount: 0, unit: 'seconds' })
    expect(splitInterval(2.6)).toEqual({ amount: 3, unit: 'seconds' })
  })
})

describe('formatInterval', () => {
  it('writes a short unit', () => {
    expect(formatInterval(180)).toBe('3 min')
    expect(formatInterval(3600)).toBe('1 h')
    expect(formatInterval(172_800)).toBe('2 d')
    expect(formatInterval(90)).toBe('90 s')
  })
})

describe('formatScheduleLabel', () => {
  const base = { schedule_type: 'every', at_datetime: null, every_seconds: null, cron_expression: null, timezone: 'UTC' } as const

  it('says "every …" for a repeating interval', () => {
    expect(formatScheduleLabel({ ...base, every_seconds: 180 })).toBe('every 3 min')
    expect(formatScheduleLabel({ ...base, every_seconds: 3600 })).toBe('every 1 h')
  })

  it('says "cron …" with the expression', () => {
    expect(formatScheduleLabel({ ...base, schedule_type: 'cron', cron_expression: '0 9 * * 1-5' })).toBe('cron 0 9 * * 1-5')
  })

  it('says "once at" the date and time in the task timezone', () => {
    expect(formatScheduleLabel({ ...base, schedule_type: 'at', at_datetime: '2024-10-24T09:00:00Z', timezone: 'UTC' })).toBe('once at Oct 24, 2024, 09:00')
    // The saved timezone wins over the browser's
    expect(formatScheduleLabel({ ...base, schedule_type: 'at', at_datetime: '2024-10-24T09:00:00Z', timezone: 'Asia/Ho_Chi_Minh' })).toBe('once at Oct 24, 2024, 16:00')
  })

  it('falls back when the schedule has nothing to show', () => {
    expect(formatScheduleLabel({ ...base, every_seconds: null })).toBe('unknown schedule')
    expect(formatScheduleLabel({ ...base, schedule_type: 'cron', cron_expression: null })).toBe('unknown schedule')
  })
})

describe('taskState', () => {
  const state = (status: ScheduledTaskResponse['status'], enabled = true, next_fire_at: string | null = null) =>
    taskState({ status, enabled, next_fire_at })

  it('calls a waiting, enabled task "Scheduled"', () => {
    expect(state('pending')).toEqual({ label: 'Scheduled', tone: 'neutral' })
  })

  it('calls a disabled or paused task "Paused", in quiet text', () => {
    expect(state('pending', false)).toEqual({ label: 'Paused', tone: 'neutral' })
    expect(state('paused')).toEqual({ label: 'Paused', tone: 'neutral' })
  })

  it('calls a finished one-off "Done", in quiet text', () => {
    expect(state('completed')).toEqual({ label: 'Done', tone: 'neutral' })
  })

  it('says the last run failed when the task will still run again', () => {
    expect(state('failed', true, '2026-10-25T09:00:00Z')).toEqual({ label: 'Last run failed', tone: 'error' })
    expect(state('failed')).toEqual({ label: 'Failed', tone: 'error' })
  })

  it('shows a running task with a spinner', () => {
    expect(state('running')).toEqual({ label: 'Running', tone: 'info', spinner: true })
  })
})

describe('lastRunLabel', () => {
  it('says "Not run yet" without a last run', () => {
    expect(lastRunLabel({ last_run_at: null, last_error: null }, NOW)).toBe('Not run yet')
    expect(lastRunLabel({ last_run_at: 'garbage', last_error: null }, NOW)).toBe('Not run yet')
  })

  it('says how long ago it ran and how it went', () => {
    expect(lastRunLabel({ last_run_at: ago(2 * 60_000), last_error: null }, NOW)).toBe('Last run 2m ago · ok')
    expect(lastRunLabel({ last_run_at: ago(3 * 3_600_000), last_error: null }, NOW)).toBe('Last run 3h ago · ok')
    // Hours under a day, then days, as every list counts (DESIGN.md → Dates)
    expect(lastRunLabel({ last_run_at: ago(23 * 3_600_000), last_error: null }, NOW)).toBe('Last run 23h ago · ok')
    expect(lastRunLabel({ last_run_at: ago(47 * 3_600_000), last_error: null }, NOW)).toBe('Last run 1d ago · ok')
    expect(lastRunLabel({ last_run_at: ago(60 * 60_000), last_error: 'boom' }, NOW)).toBe('Last run 1h ago · failed')
  })

  it('says "just now" inside the first minute', () => {
    expect(lastRunLabel({ last_run_at: ago(10_000), last_error: null }, NOW)).toBe('Last run just now · ok')
  })

  it('counts days under a week, then names the date', () => {
    expect(lastRunLabel({ last_run_at: ago(5 * 86_400_000), last_error: null }, NOW)).toBe('Last run 5d ago · ok')
    expect(lastRunLabel({ last_run_at: ago(75 * 86_400_000), last_error: null }, NOW)).toBe('Last run Aug 10 · ok')
  })
})

describe('nextRunLabel', () => {
  it('has nothing to say without a next run', () => {
    expect(nextRunLabel({ next_fire_at: null }, NOW)).toBeNull()
    expect(nextRunLabel({ next_fire_at: 'garbage' }, NOW)).toBeNull()
  })

  it('says when the next run comes', () => {
    expect(nextRunLabel({ next_fire_at: ahead(60_000) }, NOW)).toBe('Next run in 1m')
    expect(nextRunLabel({ next_fire_at: ahead(2 * 3_600_000) }, NOW)).toBe('Next run in 2h')
    expect(nextRunLabel({ next_fire_at: ahead(4 * 86_400_000) }, NOW)).toBe('Next run in 4d')
    expect(nextRunLabel({ next_fire_at: ahead(30 * 86_400_000) }, NOW)).toBe('Next run Nov 23')
  })

  it('says it is due when the time has come or passed', () => {
    expect(nextRunLabel({ next_fire_at: ahead(10_000) }, NOW)).toBe('Next run due now')
    expect(nextRunLabel({ next_fire_at: ago(5 * 60_000) }, NOW)).toBe('Next run due now')
  })
})

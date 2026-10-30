import { describe, expect, it } from 'bun:test'
import { isValidCron, previewCron } from '@/components/SchedulerPanel/cron'

describe('isValidCron', () => {
  it('accepts five fields, and an optional sixth seconds field', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
    expect(isValidCron('* * * * *')).toBe(true)
    expect(isValidCron('30 0 9 * * 1-5')).toBe(true)
    expect(isValidCron('  0   9 * * *  ')).toBe(true)
  })

  it('accepts @ aliases', () => {
    for (const alias of ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly', '@DAILY']) {
      expect(isValidCron(alias)).toBe(true)
    }
    expect(isValidCron('@sometimes')).toBe(false)
  })

  it('accepts month and weekday names, ranges, lists and steps', () => {
    expect(isValidCron('0 9 * * MON-FRI')).toBe(true)
    expect(isValidCron('0 9 * * mon,wed,fri')).toBe(true)
    expect(isValidCron('0 0 1 JAN,JUL *')).toBe(true)
    expect(isValidCron('*/15 * * * *')).toBe(true)
    expect(isValidCron('0-30/10 9-17 * * *')).toBe(true)
    expect(isValidCron('0 9 * * 7')).toBe(true)
  })

  it('accepts a last day of the month and an nth weekday', () => {
    expect(isValidCron('0 0 L * *')).toBe(true)
    expect(isValidCron('0 9 * * 1#2')).toBe(true)
  })

  it('rejects out-of-range values, the wrong number of fields, and malformed parts', () => {
    expect(isValidCron('61 * * * *')).toBe(false)
    expect(isValidCron('* 24 * * *')).toBe(false)
    expect(isValidCron('* * 32 * *')).toBe(false)
    expect(isValidCron('* * 0 * *')).toBe(false)
    expect(isValidCron('* * * 13 *')).toBe(false)
    expect(isValidCron('* * * *')).toBe(false)
    expect(isValidCron('* * *')).toBe(false)
    expect(isValidCron('* * * * * * *')).toBe(false)
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('*/0 * * * *')).toBe(false)
    expect(isValidCron('5-1 * * * *')).toBe(false)
    expect(isValidCron('a * * * *')).toBe(false)
    expect(isValidCron('0 9 * * 1#9')).toBe(false)
    expect(isValidCron('0,,5 * * * *')).toBe(false)
  })
})

describe('previewCron descriptions', () => {
  const describeOf = (expr: string) => previewCron(expr, '2026-10-24T20:13').description

  it('describes the common shapes in words', () => {
    expect(describeOf('0 9 * * 1-5')).toBe('Weekdays at 09:00')
    expect(describeOf('*/15 * * * *')).toBe('Every 15 minutes')
    expect(describeOf('30 * * * *')).toBe('Every hour at :30')
    expect(describeOf('0 0 1 * *')).toBe('Day 1 of every month at 00:00')
    expect(describeOf('* * * * *')).toBe('Every minute')
    expect(describeOf('0 */6 * * *')).toBe('Every 6 hours at :00')
    expect(describeOf('15 7 * * *')).toBe('Every day at 07:15')
    expect(describeOf('0 10 * * 0,6')).toBe('Weekends at 10:00')
    expect(describeOf('0 8 * * 1,3')).toBe('Mon, Wed at 08:00')
    expect(describeOf('0 0 L * *')).toBe('Last day of every month at 00:00')
  })

  it('describes aliases through their expansion', () => {
    expect(describeOf('@daily')).toBe('Every day at 00:00')
    expect(describeOf('@hourly')).toBe('Every hour at :00')
  })

  it('has no description for shapes it does not summarize, but still validates them', () => {
    const custom = previewCron('0 9 1 6 *', '2026-10-24T20:13')
    expect(custom.valid).toBe(true)
    expect(custom.description).toBeNull()
    // A seconds field is valid but has no short description
    const withSeconds = previewCron('30 0 9 * * *', '2026-10-24T20:13')
    expect(withSeconds.valid).toBe(true)
    expect(withSeconds.description).toBeNull()
  })

  it('reports an invalid expression without a description or next run', () => {
    expect(previewCron('61 * * * *', '2026-10-24T20:13')).toEqual({ valid: false, description: null, next: null })
    expect(previewCron('* * *', '2026-10-24T20:13')).toEqual({ valid: false, description: null, next: null })
  })
})

describe('previewCron next run', () => {
  const nextOf = (expr: string, now: string) => previewCron(expr, now).next

  it('finds the next weekday morning from a Saturday evening', () => {
    // Oct 24 2026 is a Saturday: the next weekday 09:00 is Monday Oct 26.
    expect(nextOf('0 9 * * 1-5', '2026-10-24T20:13')).toBe('Mon Oct 26, 09:00')
  })

  it('finds a later time on the same day', () => {
    expect(nextOf('0 21 * * *', '2026-10-24T20:13')).toBe('Sat Oct 24, 21:00')
  })

  it('is strictly after now: a run due this very minute waits for the next one', () => {
    expect(nextOf('13 20 * * *', '2026-10-24T20:13')).toBe('Sun Oct 25, 20:13')
    expect(nextOf('* * * * *', '2026-10-24T20:13')).toBe('Sat Oct 24, 20:14')
  })

  it('steps through minutes and rolls into the next hour', () => {
    expect(nextOf('*/15 * * * *', '2026-10-24T20:46')).toBe('Sat Oct 24, 21:00')
  })

  it('finds a day of the month, rolling into the next month and year', () => {
    expect(nextOf('0 0 1 * *', '2026-10-24T20:13')).toBe('Sun Nov 1, 00:00')
    expect(nextOf('0 0 1 1 *', '2026-10-24T20:13')).toBe('Fri Jan 1, 00:00')
  })

  it('finds the last day of the month', () => {
    expect(nextOf('0 0 L * *', '2026-10-24T20:13')).toBe('Sat Oct 31, 00:00')
    expect(nextOf('0 0 L * *', '2026-02-10T00:00')).toBe('Sat Feb 28, 00:00')
  })

  it('finds an nth weekday of the month', () => {
    // The second Monday of November 2026 is Nov 9.
    expect(nextOf('0 9 * * 1#2', '2026-10-24T20:13')).toBe('Mon Nov 9, 09:00')
  })

  it('reads names like numbers', () => {
    expect(nextOf('0 9 * * MON-FRI', '2026-10-24T20:13')).toBe('Mon Oct 26, 09:00')
  })

  it('has no next run for an invalid expression or an unreadable clock', () => {
    expect(nextOf('61 * * * *', '2026-10-24T20:13')).toBeNull()
    expect(nextOf('0 9 * * *', 'not a date')).toBeNull()
  })

  it('has no next run for a date that never comes (Feb 30)', () => {
    expect(nextOf('0 0 30 2 *', '2026-10-24T20:13')).toBeNull()
  })
})

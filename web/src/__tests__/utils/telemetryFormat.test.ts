import { describe, it, expect } from 'bun:test'
import {
  formatCompact,
  formatInt,
  formatMs,
  formatPercent,
  formatShortId,
  formatTps,
  formatUsd,
  timeAgo,
} from '@/utils/telemetryFormat'

describe('formatTps', () => {
  it('reads as tokens per second, one decimal only when slow', () => {
    expect(formatTps(54.4)).toBe('54 tok/s')
    expect(formatTps(7.25)).toBe('7.3 tok/s')
  })

  it('returns a dash when nothing was measured', () => {
    expect(formatTps(0)).toBe('-')
    expect(formatTps(Number.NaN)).toBe('-')
  })
})

describe('formatInt', () => {
  it('adds thousands separators', () => {
    expect(formatInt(0)).toBe('0')
    expect(formatInt(1234)).toBe('1,234')
    expect(formatInt(1_000_000)).toBe('1,000,000')
  })
})

describe('formatCompact', () => {
  it('uses plain format below 1000', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(999)).toBe('999')
  })

  it('uses compact notation at and above 1000', () => {
    expect(formatCompact(1500)).toBe('1.5K')
    expect(formatCompact(1_200_000)).toBe('1.2M')
  })
})

describe('formatMs', () => {
  it('returns a dash for zero', () => {
    expect(formatMs(0)).toBe('-')
  })

  it('returns a dash for missing or impossible durations instead of "NaN s"', () => {
    expect(formatMs(Number.NaN)).toBe('-')
    expect(formatMs(Number.POSITIVE_INFINITY)).toBe('-')
    expect(formatMs(-5)).toBe('-')
  })

  it('returns ms below 1000', () => {
    expect(formatMs(250)).toBe('250 ms')
    expect(formatMs(999)).toBe('999 ms')
  })

  it('switches to seconds at and above 1000', () => {
    expect(formatMs(1500)).toBe('1.5 s')
    expect(formatMs(60_000)).toBe('60.0 s')
  })
})

describe('formatUsd', () => {
  it('returns an em-dash for non-positive or invalid values', () => {
    expect(formatUsd(0)).toBe('-')
    expect(formatUsd(Number.NaN)).toBe('-')
  })

  it('formats small estimated model costs with useful precision', () => {
    expect(formatUsd(0.00135)).toBe('$0.00135')
    expect(formatUsd(12.5)).toBe('$12.50')
  })
})

describe('formatPercent', () => {
  it('formats cache percentages compactly', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(8.25)).toBe('8.3%')
    expect(formatPercent(42.2)).toBe('42%')
  })
})

describe('timeAgo', () => {
  const now = 1_000_000_000_000 // fixed reference

  it('renders seconds under a minute', () => {
    expect(timeAgo(now - 5_000, now)).toBe('5s ago')
    expect(timeAgo(now, now)).toBe('0s ago')
  })

  it('renders minutes under an hour', () => {
    expect(timeAgo(now - 3 * 60 * 1000, now)).toBe('3m ago')
    expect(timeAgo(now - 59 * 60 * 1000, now)).toBe('59m ago')
  })

  it('renders hours under a day', () => {
    expect(timeAgo(now - 2 * 3600 * 1000, now)).toBe('2h ago')
  })

  it('renders days under a week', () => {
    expect(timeAgo(now - 3 * 86400 * 1000, now)).toBe('3d ago')
  })

  it('names the date beyond a week, like every list ("Oct 29")', () => {
    const past = now - 10 * 86400 * 1000
    const label = timeAgo(past, now)
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/)
  })

  it('clamps future timestamps to 0s ago', () => {
    expect(timeAgo(now + 10_000, now)).toBe('0s ago')
  })
})

describe('formatShortId', () => {
  it('returns short ids unchanged', () => {
    expect(formatShortId('abc123')).toBe('abc123')
    expect(formatShortId('0xabc')).toBe('abc') // strips 0x prefix
  })

  it('strips the 0x prefix from hex ids', () => {
    expect(formatShortId('0x0123456789abcdef0123')).toBe('01234567…0123')
  })

  it('adds a mid-ellipsis for long ids', () => {
    const long = 'abcdefghijklmnop'
    expect(formatShortId(long)).toBe('abcdefgh…mnop')
  })
})

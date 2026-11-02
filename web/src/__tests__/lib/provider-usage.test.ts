import { describe, expect, it } from 'bun:test'

import { ApiValidationError } from '@/api/client'
import {
  MAX_DATE_MS,
  STALE_MAX_MS,
  cooldownRemainingMs,
  formatRetryIn,
  isSnapshotExpired,
  parseUsageResponse,
  snapshotUpdatedAtMs,
  toProviderUsageError,
} from '@/lib/provider-usage'

const NOW = 1_800_000_000_000

function rateLimited(detail: Record<string, unknown>) {
  return new ApiValidationError(429, 'Usage is rate-limited.', { code: 'usage_rate_limited', message: 'Usage is rate-limited.', ...detail })
}

describe('toProviderUsageError', () => {
  it('reads retry_at and a last-good snapshot from a 429', () => {
    const err = toProviderUsageError(
      rateLimited({
        retry_at: NOW / 1000 + 188,
        retry_after: 188,
        last_good: { provider: 'codex', stale: true, updated_at: NOW / 1000 - 240, limits: [{ limit_id: 'a', primary: { used_percent: 40 } }] },
      }),
      NOW,
    )
    expect(err.kind).toBe('rate_limited')
    expect(err.retryAtMs).toBe(NOW + 188_000)
    expect(err.lastGood?.updated_at).toBe(NOW / 1000 - 240)
    expect(err.lastGood?.limits[0].primary?.used_percent).toBe(40)
  })

  it('keeps a valid long wait as given, however long', () => {
    const twoDays = toProviderUsageError(rateLimited({ retry_after: 48 * 3600 }), NOW)
    expect(twoDays.retryAtMs).toBe(NOW + 48 * 3600 * 1000)
    const atOnly = toProviderUsageError(rateLimited({ retry_at: NOW / 1000 + 10 * 86400 }), NOW)
    expect(atOnly.retryAtMs).toBe(NOW + 10 * 86400 * 1000)
  })

  it('falls back to a short default for timing a JS Date cannot hold, rather than clamping it', () => {
    for (const huge of [9e12, 1e300, 8.64e15]) {
      const e = toProviderUsageError(rateLimited({ retry_at: huge, retry_after: huge }), NOW)
      expect(e.retryAtMs).toBe(NOW + 60_000)
    }
    expect(NOW + 48 * 3600 * 1000).toBeLessThanOrEqual(MAX_DATE_MS)

    const text = toProviderUsageError(rateLimited({ retry_at: 'soon', retry_after: 90 }), NOW)
    expect(text.retryAtMs).toBe(NOW + 90_000)

    for (const bad of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY, null]) {
      const e = toProviderUsageError(rateLimited({ retry_at: bad, retry_after: bad }), NOW)
      expect(e.retryAtMs).toBe(NOW + 60_000)
    }
  })

  it('prefers the relative wait so a skewed clock cannot shorten or stretch it', () => {
    const skewed = toProviderUsageError(rateLimited({ retry_at: NOW / 1000 - 3600, retry_after: 188 }), NOW)
    expect(skewed.retryAtMs).toBe(NOW + 188_000)
    const both = toProviderUsageError(rateLimited({ retry_at: NOW / 1000 + 5000, retry_after: 188 }), NOW)
    expect(both.retryAtMs).toBe(NOW + 188_000)
    const onlyAt = toProviderUsageError(rateLimited({ retry_at: NOW / 1000 + 120 }), NOW)
    expect(onlyAt.retryAtMs).toBe(NOW + 120_000)
  })

  it('does not trust a raw last_good snapshot', () => {
    const junk = toProviderUsageError(rateLimited({ retry_after: 30, last_good: { limits: 'nope', updated_at: NOW / 1000 - 60 } }), NOW)
    expect(junk.lastGood).toBeNull()

    const partial = toProviderUsageError(
      rateLimited({
        retry_after: 30,
        last_good: {
          provider: 'x',
          updated_at: NOW / 1000 - 60,
          limits: [{ limit_id: 'a', primary: { used_percent: 'lots' }, secondary: { used_percent: 7, resets_at: 'never' }, plan_type: 5 }, 'garbage'],
        },
      }),
      NOW,
    )
    expect(partial.lastGood?.updated_at).toBe(NOW / 1000 - 60)
    expect(partial.lastGood?.limits).toHaveLength(1)
    expect(partial.lastGood?.limits[0].primary).toBeUndefined()
    expect(partial.lastGood?.limits[0].secondary?.used_percent).toBe(7)
    expect(partial.lastGood?.limits[0].secondary?.resets_at).toBeUndefined()
    expect(partial.lastGood?.limits[0].plan_type).toBeUndefined()
  })

  it('requires a believable timestamp on last_good, never inventing "just now"', () => {
    const last = (updated_at: unknown) =>
      toProviderUsageError(rateLimited({ retry_after: 30, last_good: { provider: 'x', limits: [], updated_at } }), NOW).lastGood
    expect(last(undefined)).toBeNull()
    expect(last('yesterday')).toBeNull()
    expect(last(Number.NaN)).toBeNull()
    expect(last(-1)).toBeNull()
    expect(last(0)).toBeNull()
    expect(last(1e300)).toBeNull()
    expect(last(NOW / 1000 + 3600)).toBeNull() // from the future
    expect(last(NOW / 1000 + 5)?.updated_at).toBe(NOW / 1000 + 5) // a few seconds of clock skew is fine
    expect(last(NOW / 1000 - 600)?.updated_at).toBe(NOW / 1000 - 600)
  })

  it('treats any 429 as rate limited, and a 401/403 as needing sign-in', () => {
    const status = (s: number, detail?: unknown) => toProviderUsageError(new ApiValidationError(s, 'x', detail), NOW).kind
    expect(status(429, { code: 'something_new', message: 'x', retry_after: 5 })).toBe('rate_limited')
    expect(status(429, 'plain string detail')).toBe('rate_limited')
    expect(status(401)).toBe('credentials')
    expect(status(403, { message: 'no' })).toBe('credentials')
    // A named code still wins for the other statuses.
    expect(status(502, { code: 'usage_rejected', message: 'x' })).toBe('rejected')
  })

  it('does not call a missing named account "unsupported"', () => {
    const notFound = new ApiValidationError(404, 'Not found')
    expect(toProviderUsageError(notFound, NOW).kind).toBe('unsupported')
    expect(toProviderUsageError(notFound, NOW, { scoped: true }).kind).toBe('unavailable')
    // An explicit code is still believed.
    expect(toProviderUsageError(new ApiValidationError(404, 'x', { code: 'usage_unsupported', message: 'x' }), NOW, { scoped: true }).kind).toBe('unsupported')
  })

  it('classifies the other usage error codes and plain failures', () => {
    const kind = (status: number, code: string) =>
      toProviderUsageError(new ApiValidationError(status, 'x', { code, message: 'x' }), NOW).kind
    expect(kind(400, 'usage_unsupported')).toBe('unsupported')
    expect(kind(401, 'usage_credentials')).toBe('credentials')
    expect(kind(502, 'usage_unavailable')).toBe('unavailable')
    expect(kind(502, 'usage_rejected')).toBe('rejected')
    expect(toProviderUsageError(new ApiValidationError(404, 'Not found'), NOW).kind).toBe('unsupported')
    expect(toProviderUsageError(new Error('network down'), NOW).kind).toBe('unavailable')
    expect(toProviderUsageError('weird', NOW).kind).toBe('unavailable')
  })

  it('returns the same instance when it is already typed', () => {
    const typed = toProviderUsageError(rateLimited({ retry_after: 10 }), NOW)
    expect(toProviderUsageError(typed, NOW + 5_000)).toBe(typed)
  })

  it('keeps a last-good snapshot that arrives on an unavailable error', () => {
    const err = toProviderUsageError(
      new ApiValidationError(502, 'x', { code: 'usage_unavailable', message: 'x', last_good: { provider: 'p', updated_at: 5, limits: [] } }),
      NOW,
    )
    expect(err.kind).toBe('unavailable')
    expect(err.lastGood?.updated_at).toBe(5)
  })
})

describe('cooldown helpers', () => {
  it('counts down only for rate-limited errors', () => {
    const limited = toProviderUsageError(rateLimited({ retry_after: 60 }), NOW)
    expect(cooldownRemainingMs(limited, NOW + 10_000)).toBe(50_000)
    expect(cooldownRemainingMs(limited, NOW + 70_000)).toBe(0)
    expect(cooldownRemainingMs(new Error('x'), NOW)).toBe(0)
    expect(cooldownRemainingMs(null, NOW)).toBe(0)
  })

  it('formats the retry time', () => {
    expect(formatRetryIn(188_000)).toBe('3m 08s')
    expect(formatRetryIn(59_100)).toBe('59s')
    expect(formatRetryIn(3_600_000 + 5 * 60_000)).toBe('1h 05m')
    expect(formatRetryIn(0)).toBe('0s')
  })
})

describe('snapshot parsing', () => {
  it('prefers the server timestamp over when the client received it', () => {
    expect(snapshotUpdatedAtMs({ provider: 'p', limits: [], updated_at: 1000 }, 5)).toBe(1_000_000)
    expect(snapshotUpdatedAtMs({ provider: 'p', limits: [], updated_at: 1e300 }, 9)).toBe(9)
    expect(snapshotUpdatedAtMs({ provider: 'p', limits: [], updated_at: -4 }, 9)).toBe(9)
    // From the future: never newer than now.
    expect(snapshotUpdatedAtMs({ provider: 'p', limits: [], updated_at: Date.now() / 1000 + 86400 }, 9)).toBeLessThanOrEqual(Date.now())
    expect(snapshotUpdatedAtMs({ provider: 'p', limits: [] }, 5)).toBe(5)
    expect(snapshotUpdatedAtMs({ provider: 'p', limits: [], updated_at: Number.NaN }, 7)).toBe(7)
  })

  it('sanitizes a successful response without dropping a 0% window', () => {
    const parsed = parseUsageResponse({ provider: 'p', updated_at: 12, limits: [{ primary: { used_percent: 0 }, spend: { reached: false, currency: 'USD', used: 1, limit: 5 } }] })
    expect(parsed.limits[0].primary?.used_percent).toBe(0)
    expect(parsed.limits[0].spend?.currency).toBe('USD')
    expect(parsed.updated_at).toBe(12)
  })

  it('drops a response timestamp a Date cannot hold', () => {
    expect(parseUsageResponse({ provider: 'p', limits: [], updated_at: 1e300 }).updated_at).toBeUndefined()
    expect(parseUsageResponse({ provider: 'p', limits: [], updated_at: 0 }).updated_at).toBeUndefined()
  })
})

describe('snapshot age', () => {
  it('expires a held snapshot after 30 minutes', () => {
    expect(STALE_MAX_MS).toBe(30 * 60 * 1000)
    expect(isSnapshotExpired(NOW - STALE_MAX_MS + 1000, NOW)).toBe(false)
    expect(isSnapshotExpired(NOW - STALE_MAX_MS - 1000, NOW)).toBe(true)
  })
})

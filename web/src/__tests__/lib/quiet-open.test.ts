import { describe, it, expect, beforeEach } from 'bun:test'
import { markQuietOpen, takeQuietOpen, takeQuietOpenFromRoute, _resetQuietOpenForTests } from '@/lib/quiet-open'

beforeEach(() => _resetQuietOpenForTests())

describe('quiet open', () => {
  it('holds one quiet open per session, taken once', () => {
    markQuietOpen('s1')
    expect(takeQuietOpen('s2')).toBe(false)
    expect(takeQuietOpen('s1')).toBe(true)
    expect(takeQuietOpen('s1')).toBe(false)
  })

  it('reads a new window route with ?quiet=1 and drops the flag from it', () => {
    const id = '5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f'
    expect(takeQuietOpenFromRoute(`/${id}?quiet=1`)).toBe(`/${id}`)
    expect(takeQuietOpen(id)).toBe(true)
    expect(takeQuietOpenFromRoute(`/${id}?tab=review&quiet=1`)).toBe(`/${id}?tab=review`)
    expect(takeQuietOpenFromRoute(`/${id}`)).toBe(`/${id}`)
    expect(takeQuietOpenFromRoute(undefined)).toBeUndefined()
  })
})

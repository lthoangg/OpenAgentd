import { describe, expect, it } from 'bun:test'
import { closestRestorableRoute } from '@/lib/route-restore'

describe('closestRestorableRoute', () => {
  it('falls back stale coding session routes to the coding hub', () => {
    expect(closestRestorableRoute('/coding/session-123')).toBe('/coding')
  })

  it('falls back stale cockpit session routes to the cockpit hub', () => {
    expect(closestRestorableRoute('/cockpit/session-123')).toBe('/cockpit')
  })

  it('preserves stable top-level routes', () => {
    expect(closestRestorableRoute('/telemetry')).toBe('/telemetry')
  })

  it('redirects all /settings/* paths to home (settings is now a modal)', () => {
    expect(closestRestorableRoute('/settings/providers')).toBe('/')
    expect(closestRestorableRoute('/settings/agents')).toBe('/')
    expect(closestRestorableRoute('/settings')).toBe('/')
  })

  it('preserves query/hash suffixes when falling back', () => {
    expect(closestRestorableRoute('/coding/session-123?tab=files#diff')).toBe('/coding?tab=files#diff')
  })
})

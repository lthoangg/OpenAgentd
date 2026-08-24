import { describe, expect, it } from 'bun:test'
import { closestRestorableRoute } from '@/lib/route-restore'
import { router } from '@/router'

describe('closestRestorableRoute', () => {
  it('falls back stale coding session routes to the coding hub', () => {
    expect(closestRestorableRoute('/coding/session-123')).toBe('/coding')
  })

  it('normalizes legacy cockpit routes to coding', () => {
    expect(closestRestorableRoute('/cockpit/session-123')).toBe('/coding')
    expect(closestRestorableRoute('/cockpit')).toBe('/coding')
  })

  it('keeps query and hash state when normalizing legacy cockpit routes', () => {
    expect(closestRestorableRoute('/cockpit/session-123?tab=files#diff')).toBe('/coding?tab=files#diff')
    expect(closestRestorableRoute('/cockpit?notice=ready#status')).toBe('/coding?notice=ready#status')
  })

  it('preserves stable top-level routes', () => {
    expect(closestRestorableRoute('/telemetry')).toBe('/telemetry')
  })

  it('canonicalizes the packaged desktop entrypoint to home', () => {
    expect(closestRestorableRoute('/index.html?oa-window-id=main#ready')).toBe('/?oa-window-id=main#ready')
  })

  it('redirects all /settings/* paths to home (settings is now a modal)', () => {
    expect(closestRestorableRoute('/settings/providers')).toBe('/')
    expect(closestRestorableRoute('/settings/agents')).toBe('/')
    expect(closestRestorableRoute('/settings')).toBe('/')
  })

  it('provides normalized targets for native initial routes', () => {
    expect(closestRestorableRoute('/settings/providers?section=auth#provider')).toBe('/')
  })

  it('preserves query/hash suffixes when falling back', () => {
    expect(closestRestorableRoute('/coding/session-123?tab=files#diff')).toBe('/coding?tab=files#diff')
  })
})

describe('root route', () => {
  it('redirects / to Coding', () => {
    expect(typeof router.routesById['/'].options.beforeLoad).toBe('function')
  })
})

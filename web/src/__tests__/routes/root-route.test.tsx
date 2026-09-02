import { describe, expect, it } from 'bun:test'
import { closestRestorableRoute, LAST_ROUTE_KEY, lastRouteStorageKey } from '@/lib/route-restore'
import { router } from '@/router'

describe('closestRestorableRoute', () => {
  it('preserves coding session routes on reload and route restore', () => {
    expect(closestRestorableRoute('/coding/session-123')).toBe('/coding/session-123')
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

  it('preserves query/hash suffixes on coding session routes', () => {
    expect(closestRestorableRoute('/coding/session-123?tab=files#diff')).toBe('/coding/session-123?tab=files#diff')
  })

  it('preserves query/hash suffixes on scheduler and telemetry routes', () => {
    expect(closestRestorableRoute('/scheduler?q=sync#task-1')).toBe('/scheduler?q=sync#task-1')
    expect(closestRestorableRoute('/telemetry?days=7#traces')).toBe('/telemetry?days=7#traces')
  })
})

describe('lastRouteStorageKey', () => {
  it('returns plain key in browser environment without dataset params', () => {
    delete document.documentElement.dataset.openagentdAppId
    delete document.documentElement.dataset.openagentdWindowId
    expect(lastRouteStorageKey()).toBe(LAST_ROUTE_KEY)
  })

  it('namespaces storage key when app and window ids are present on html dataset', () => {
    document.documentElement.dataset.openagentdAppId = 'com.openagentd.desktop'
    document.documentElement.dataset.openagentdWindowId = 'main'
    expect(lastRouteStorageKey()).toBe('oa-last-route:com.openagentd.desktop:main')

    delete document.documentElement.dataset.openagentdAppId
    delete document.documentElement.dataset.openagentdWindowId
  })
})

describe('root route', () => {
  it('redirects / to Coding', () => {
    expect(typeof router.routesById['/'].options.beforeLoad).toBe('function')
  })
})

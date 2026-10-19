import { describe, expect, it } from 'bun:test'
import { isRedirect } from '@tanstack/react-router'
import {
  closestRestorableRoute,
  forgetRouteForBackendSwitch,
  LAST_ROUTE_KEY,
  lastRouteStorageKey,
  resolveStartupRoute,
} from '@/lib/route-restore'
import { router } from '@/router'

describe('closestRestorableRoute', () => {
  it('preserves session routes on reload and route restore', () => {
    expect(closestRestorableRoute('/session-123')).toBe('/session-123')
    expect(closestRestorableRoute('/')).toBe('/')
  })

  it('rewrites saved /coding routes from older builds', () => {
    expect(closestRestorableRoute('/coding/session-123')).toBe('/session-123')
    expect(closestRestorableRoute('/coding')).toBe('/')
    expect(closestRestorableRoute('/coding/')).toBe('/')
    expect(closestRestorableRoute('/coding/session-123?tab=files#diff')).toBe('/session-123?tab=files#diff')
  })

  it('normalizes legacy cockpit routes to a new session', () => {
    expect(closestRestorableRoute('/cockpit/session-123')).toBe('/')
    expect(closestRestorableRoute('/cockpit')).toBe('/')
  })

  it('keeps query and hash state when normalizing legacy cockpit routes', () => {
    expect(closestRestorableRoute('/cockpit/session-123?tab=files#diff')).toBe('/?tab=files#diff')
    expect(closestRestorableRoute('/cockpit?notice=ready#status')).toBe('/?notice=ready#status')
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

  it('preserves query/hash suffixes on session routes', () => {
    expect(closestRestorableRoute('/session-123?tab=files#diff')).toBe('/session-123?tab=files#diff')
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
    delete window.__OAD_APP_ID__
    delete window.__OAD_WINDOW_ID__
    expect(lastRouteStorageKey()).toBe(LAST_ROUTE_KEY)
  })

  it('namespaces storage key when app and window ids are present on html dataset', () => {
    document.documentElement.dataset.openagentdAppId = 'com.openagentd.desktop'
    document.documentElement.dataset.openagentdWindowId = 'main'
    expect(lastRouteStorageKey()).toBe('oa-last-route:com.openagentd.desktop:main')

    delete document.documentElement.dataset.openagentdAppId
    delete document.documentElement.dataset.openagentdWindowId
  })

  it('namespaces storage key from the injected identity after a reload', () => {
    delete document.documentElement.dataset.openagentdAppId
    delete document.documentElement.dataset.openagentdWindowId
    window.__OAD_APP_ID__ = 'com.openagentd.desktop'
    window.__OAD_WINDOW_ID__ = 'main-2'

    expect(lastRouteStorageKey()).toBe('oa-last-route:com.openagentd.desktop:main-2')

    delete window.__OAD_APP_ID__
    delete window.__OAD_WINDOW_ID__
  })
})

describe('resolveStartupRoute', () => {
  const at = (fullPath: string) => ({ pathname: fullPath.replace(/[?#].*$/, ''), fullPath })

  it('keeps the exact session on a reload despite the desktop route hint', () => {
    expect(resolveStartupRoute({ initialRoute: '/', isReload: true, ...at('/abc'), savedRoute: '/abc' })).toBeNull()
    expect(resolveStartupRoute({ initialRoute: '/other', isReload: true, ...at('/abc'), savedRoute: null })).toBeNull()
  })

  it('keeps query and hash on a reload', () => {
    expect(resolveStartupRoute({ initialRoute: '/', isReload: true, ...at('/abc?tab=files#diff'), savedRoute: null })).toBeNull()
  })

  it('honours the desktop route hint on a first load', () => {
    expect(resolveStartupRoute({ initialRoute: '/', isReload: false, ...at('/'), savedRoute: '/abc' })).toBe('/')
    expect(resolveStartupRoute({ initialRoute: '/abc', isReload: false, ...at('/'), savedRoute: null })).toBe('/abc')
  })

  it('restores the saved route from the packaged entrypoint', () => {
    expect(resolveStartupRoute({ initialRoute: '/', isReload: true, ...at('/index.html'), savedRoute: '/abc' })).toBe('/abc')
    expect(resolveStartupRoute({ initialRoute: undefined, isReload: false, ...at('/index.html?x=1'), savedRoute: null })).toBe('/?x=1')
  })

  it('restores the saved route at the hub without a hint', () => {
    expect(resolveStartupRoute({ initialRoute: undefined, isReload: false, ...at('/'), savedRoute: '/abc' })).toBe('/abc')
    expect(resolveStartupRoute({ initialRoute: undefined, isReload: false, ...at('/'), savedRoute: '/' })).toBeNull()
    expect(resolveStartupRoute({ initialRoute: undefined, isReload: false, ...at('/abc'), savedRoute: '/def' })).toBeNull()
  })
})

describe('forgetRouteForBackendSwitch', () => {
  it('moves to the hub and drops the saved route', () => {
    window.history.replaceState(null, '', '/abc')
    localStorage.setItem(lastRouteStorageKey(), '/abc')

    forgetRouteForBackendSwitch()

    expect(window.location.pathname).toBe('/')
    expect(localStorage.getItem(lastRouteStorageKey())).toBeNull()
  })
})

describe('root route', () => {
  const leaf = (path: string) => router.getMatchedRoutes(path)[2]

  it('serves a new session at / and a session at /<id>', () => {
    expect(leaf('/')?.fullPath).toBe('/')
    const [, params, session] = router.getMatchedRoutes('/abc-123')
    expect(session?.fullPath).toBe('/$sessionId')
    expect(params).toEqual({ sessionId: 'abc-123' })
    expect(leaf('/telemetry')?.fullPath).toBe('/telemetry')
  })

  it('takes a draft folder from ?workspace= and ignores a malformed one', () => {
    const validate = leaf('/')?.options.validateSearch as ((search: Record<string, unknown>) => { workspace?: string }) | undefined
    expect(validate).toBeDefined()
    expect(validate!({ workspace: '/repo/project' })).toEqual({ workspace: '/repo/project' })
    expect(validate!({}).workspace).toBeUndefined()
    expect(validate!({ workspace: 42 }).workspace).toBeUndefined()
    expect(validate!({ workspace: '' }).workspace).toBeUndefined()
  })

  it('redirects old /coding links without a page of their own', () => {
    const redirectOf = (path: string, params: Record<string, string>) => {
      try {
        leaf(path)?.options.beforeLoad?.({ params } as never)
      } catch (error) {
        if (isRedirect(error)) return error.options
      }
      return null
    }
    expect(redirectOf('/coding', {})).toMatchObject({ to: '/', replace: true })
    expect(redirectOf('/coding/abc-123', { sessionId: 'abc-123' }))
      .toMatchObject({ to: '/$sessionId', params: { sessionId: 'abc-123' }, replace: true })
    expect(leaf('/coding/abc-123')?.options.component).toBeUndefined()
  })
})

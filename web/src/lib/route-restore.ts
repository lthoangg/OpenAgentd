import { windowScopedKey } from './desktop-window-identity'

export const LAST_ROUTE_KEY = 'oa-last-route'

export function lastRouteStorageKey(): string {
  return windowScopedKey(LAST_ROUTE_KEY)
}

export function closestRestorableRoute(route: string): string {
  const trimmed = route.trim()
  if (!trimmed) return '/'

  const pathMatch = trimmed.match(/^[^?#]*/)
  const pathOnly = pathMatch?.[0] ?? trimmed
  const suffix = trimmed.slice(pathOnly.length)
  if (pathOnly === '/index.html') return `/${suffix}`
  // Settings is a modal, and no page sits deeper than one segment: a deeper
  // path was saved by an older build and has no page to open.
  if (pathOnly.startsWith('/settings') || pathOnly.includes('/', 1)) return '/'
  // The phone's Servers screen: a launch opens on Sessions, as it always has.
  if (pathOnly === '/servers') return '/'
  return trimmed
}

/**
 * Links that open an overlay (Usage, Scheduled) and hand the address back
 * to ``/`` at once. They are not places to come back to: saved, every later
 * launch at ``/`` reopened the overlay the user had closed.
 */
const HANDOFF_PATHS = new Set(['/telemetry', '/scheduler'])

/** Whether the root saves this path as the one to reopen at the next launch. */
export function shouldRememberRoute(pathname: string): boolean {
  return pathname !== '/' && pathname !== '/index.html' && !HANDOFF_PATHS.has(pathname)
}

function isUsableSavedRoute(route: string | null): route is string {
  return !!route && shouldRememberRoute(route.match(/^[^?#]*/)?.[0] ?? route)
}

/**
 * Where the app should go when it first mounts, or `null` to stay put.
 *
 * `initialRoute` is the desktop's `__OAD_INITIAL_ROUTE__`. It comes from an
 * initialization script the webview re-runs on every load, so it only means
 * something on a first load. A reload keeps the current URL, so Reload
 * reopens the exact session the window was on.
 */
export function resolveStartupRoute(input: {
  initialRoute: string | undefined
  isReload: boolean
  pathname: string
  fullPath: string
  savedRoute: string | null
}): string | null {
  const { initialRoute, isReload, pathname, fullPath, savedRoute } = input
  if (initialRoute && !isReload) return closestRestorableRoute(initialRoute)
  if (pathname === '/index.html') {
    return closestRestorableRoute(isUsableSavedRoute(savedRoute) ? savedRoute : fullPath)
  }
  if (pathname === '/' && isUsableSavedRoute(savedRoute)) return closestRestorableRoute(savedRoute)
  return null
}

/**
 * Before a reload onto a different backend: the current session id belongs
 * to the old server, so land on the hub (which restores the last workspace)
 * instead of reopening it.
 */
export function forgetRouteForBackendSwitch(): void {
  localStorage.removeItem(lastRouteStorageKey())
  localStorage.removeItem(LAST_ROUTE_KEY)
  window.history.replaceState(window.history.state, '', '/')
}

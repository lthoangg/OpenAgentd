export const LAST_ROUTE_KEY = 'oa-last-route'
const DESKTOP_APP_ID_PARAM = 'oa-app-id'
const DESKTOP_WINDOW_ID_PARAM = 'oa-window-id'

export function lastRouteStorageKey(): string {
  const appId =
    (typeof document !== 'undefined' ? document.documentElement.dataset.openagentdAppId : undefined)
    ?? (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get(DESKTOP_APP_ID_PARAM) : null)
  const windowId =
    (typeof document !== 'undefined' ? document.documentElement.dataset.openagentdWindowId : undefined)
    ?? (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get(DESKTOP_WINDOW_ID_PARAM) : null)
  return appId && windowId
    ? `${LAST_ROUTE_KEY}:${appId}:${windowId}`
    : appId ? `${LAST_ROUTE_KEY}:${appId}` : LAST_ROUTE_KEY
}

export function closestRestorableRoute(route: string): string {
  const trimmed = route.trim()
  if (!trimmed) return '/'

  const pathMatch = trimmed.match(/^[^?#]*/)
  const pathOnly = pathMatch?.[0] ?? trimmed
  const suffix = trimmed.slice(pathOnly.length)
  if (pathOnly === '/index.html') return `/${suffix}`
  if (pathOnly === '/cockpit' || pathOnly.startsWith('/cockpit/')) return `/coding${suffix}`
  if (pathOnly.startsWith('/settings')) return '/'
  return trimmed
}

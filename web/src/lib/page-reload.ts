/**
 * True when the current document was loaded by a reload (⌘R, the tray's
 * Reload Window, `window.location.reload()`), not a first load or navigation.
 *
 * Desktop initialization scripts run again on every load, so first-load-only
 * hints they define (`__OAD_FRESH_WINDOW__`, `__OAD_INITIAL_ROUTE__`) must be
 * ignored on a reload. Returns false where the API is unavailable.
 */
export function isPageReload(): boolean {
  try {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    return entry?.type === 'reload'
  } catch {
    return false
  }
}

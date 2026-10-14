/**
 * Desktop New Window flag.
 *
 * Rust marks a window opened with New Window (⌘⇧N) by defining
 * `window.__OAD_FRESH_WINDOW__` (see `FRESH_WINDOW_INIT_SCRIPT` in
 * `desktop/src-tauri/src/window.rs`). Such a window starts on an empty new
 * session instead of reopening the last workspace's latest session.
 *
 * The flag is an initialization script, so the webview defines it again on
 * every load. A reload is not a new window, so it is ignored then. It is
 * cleared once the window opens a session; a later return to `/` restores
 * the last workspace as usual.
 */

declare global {
  interface Window {
    __OAD_FRESH_WINDOW__?: boolean
  }
}

function isReload(): boolean {
  try {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    return entry?.type === 'reload'
  } catch {
    return false
  }
}

export function isFreshDesktopWindow(): boolean {
  if (typeof window === 'undefined' || window.__OAD_FRESH_WINDOW__ !== true) return false
  if (isReload()) {
    clearFreshDesktopWindow()
    return false
  }
  return true
}

export function clearFreshDesktopWindow(): void {
  if (typeof window !== 'undefined') delete window.__OAD_FRESH_WINDOW__
}

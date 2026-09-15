/**
 * Desktop window identity.
 *
 * Desktop windows share one webview origin, so per-window state (theme
 * preference, last route) is namespaced by Tauri's app identifier and window
 * label. Rust injects both as `window.__OAD_APP_ID__` / `__OAD_WINDOW_ID__`
 * through a webview initialization script, which re-runs on every document
 * load (see `desktop/src-tauri/src/window.rs::window_identity_init_script`).
 *
 * The `oa-app-id` / `oa-window-id` query params are only present on the
 * initial webview URL: the SPA router (browser history) rewrites
 * `window.location` to a bare route path, so a reload no longer carries them.
 * They remain the fallback for browser builds and dev, never the source of
 * truth. `web/public/theme-init.js` mirrors this resolution for the pre-paint
 * pass — keep the two in sync.
 */

declare global {
  interface Window {
    __OAD_APP_ID__?: string
    __OAD_WINDOW_ID__?: string
  }
}

const APP_ID_PARAM = 'oa-app-id'
const WINDOW_ID_PARAM = 'oa-window-id'

export function desktopAppId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  if (typeof window.__OAD_APP_ID__ === 'string' && window.__OAD_APP_ID__) {
    return window.__OAD_APP_ID__
  }
  if (typeof document !== 'undefined' && document.documentElement.dataset.openagentdAppId) {
    return document.documentElement.dataset.openagentdAppId
  }
  return new URLSearchParams(window.location.search).get(APP_ID_PARAM) ?? undefined
}

export function desktopWindowId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  if (typeof window.__OAD_WINDOW_ID__ === 'string' && window.__OAD_WINDOW_ID__) {
    return window.__OAD_WINDOW_ID__
  }
  if (typeof document !== 'undefined' && document.documentElement.dataset.openagentdWindowId) {
    return document.documentElement.dataset.openagentdWindowId
  }
  return new URLSearchParams(window.location.search).get(WINDOW_ID_PARAM) ?? undefined
}

/**
 * Namespace a per-window storage key. Browser builds and single-window
 * contexts keep the bare legacy key.
 */
export function windowScopedKey(base: string): string {
  const appId = desktopAppId()
  const windowId = desktopWindowId()
  return appId && windowId
    ? `${base}:${appId}:${windowId}`
    : appId ? `${base}:${appId}` : base
}

import { afterEach, describe, expect, it } from 'bun:test'
import { initBroadcastSync } from '@/lib/broadcast-sync'
import { QueryClient } from '@tanstack/react-query'
import {
  applyTheme,
  readStoredPreference,
  setThemePreference,
  THEME_STORAGE_KEY,
  themeStorageKey,
} from '@/lib/theme'

afterEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  delete document.documentElement.dataset.openagentdAppId
  delete document.documentElement.dataset.openagentdWindowId
  delete window.__OAD_APP_ID__
  delete window.__OAD_WINDOW_ID__
  document.documentElement.classList.remove('dark', 'light')
  document.querySelector('meta[name="theme-color"][data-openagentd-theme]')?.remove()
})

describe('theme', () => {
  it('keeps preferences isolated between desktop app identifiers', () => {
    history.replaceState(null, '', '/?oa-app-id=com.openagentd.desktop')
    document.documentElement.dataset.openagentdAppId = 'com.openagentd.desktop'
    setThemePreference('dark')

    history.replaceState(null, '', '/?oa-app-id=com.openagentd.desktop.dev')
    document.documentElement.dataset.openagentdAppId = 'com.openagentd.desktop.dev'

    expect(readStoredPreference()).toBe('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('keeps preferences isolated between desktop windows in the same app', () => {
    history.replaceState(null, '', '/?oa-app-id=com.openagentd.desktop&oa-window-id=main')
    document.documentElement.dataset.openagentdAppId = 'com.openagentd.desktop'
    document.documentElement.dataset.openagentdWindowId = 'main'
    setThemePreference('dark')

    history.replaceState(null, '', '/?oa-app-id=com.openagentd.desktop&oa-window-id=main-2')
    document.documentElement.dataset.openagentdWindowId = 'main-2'

    expect(readStoredPreference()).toBe('system')
  })

  it('syncs theme-color meta with the resolved theme', () => {
    applyTheme('dark')

    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-openagentd-theme]')
    expect(meta?.content).toBe('#0A0A0B')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    applyTheme('light')

    meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-openagentd-theme]')
    expect(meta?.content).toBe('#FAFAFA')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('does not apply broadcast theme changes targeting another window', () => {
    const queryClient = new QueryClient()
    const cleanup = initBroadcastSync(queryClient)

    history.replaceState(null, '', '/?oa-app-id=com.openagentd.desktop&oa-window-id=main-2')
    document.documentElement.dataset.openagentdAppId = 'com.openagentd.desktop'
    document.documentElement.dataset.openagentdWindowId = 'main-2'
    applyTheme('dark')

    // Simulate broadcast from window 1
    const channel = new BroadcastChannel('openagentd-sync')
    channel.postMessage({
      type: 'theme_changed',
      preference: 'light',
      storageKey: 'oa-theme:com.openagentd.desktop:main',
    })

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    channel.close()
    cleanup()
  })

  // Rust injects `__OAD_APP_ID__` / `__OAD_WINDOW_ID__` as webview globals on
  // every document load. After a reload the SPA router has already stripped
  // the `oa-window-id` query param, so this injected identity is the only
  // thing keeping a reloaded window's theme scoped instead of collapsing it
  // onto the shared legacy key.
  describe('injected window identity', () => {
    it('scopes the theme key without URL params', () => {
      window.__OAD_APP_ID__ = 'com.openagentd.desktop'
      window.__OAD_WINDOW_ID__ = 'main-2'

      expect(themeStorageKey()).toBe('oa-theme:com.openagentd.desktop:main-2')

      setThemePreference('dark')

      expect(localStorage.getItem('oa-theme:com.openagentd.desktop:main-2')).toBe('dark')
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
      expect(readStoredPreference()).toBe('dark')
    })

    it('keeps distinct reloaded windows isolated', () => {
      window.__OAD_APP_ID__ = 'com.openagentd.desktop'
      window.__OAD_WINDOW_ID__ = 'main-2'
      setThemePreference('dark')

      window.__OAD_WINDOW_ID__ = 'main-3'
      expect(readStoredPreference()).toBe('system')

      setThemePreference('light')
      expect(localStorage.getItem('oa-theme:com.openagentd.desktop:main-2')).toBe('dark')
      expect(localStorage.getItem('oa-theme:com.openagentd.desktop:main-3')).toBe('light')
    })

    it('does not apply a broadcast change despite no URL params', () => {
      const queryClient = new QueryClient()
      const cleanup = initBroadcastSync(queryClient)

      window.__OAD_APP_ID__ = 'com.openagentd.desktop'
      window.__OAD_WINDOW_ID__ = 'main-2'
      applyTheme('dark')

      const channel = new BroadcastChannel('openagentd-sync')
      channel.postMessage({
        type: 'theme_changed',
        preference: 'light',
        storageKey: 'oa-theme:com.openagentd.desktop:main',
      })

      expect(document.documentElement.classList.contains('dark')).toBe(true)
      channel.close()
      cleanup()
    })
  })
})

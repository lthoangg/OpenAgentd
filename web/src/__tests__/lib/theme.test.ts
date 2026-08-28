import { afterEach, describe, expect, it } from 'bun:test'
import { initBroadcastSync } from '@/lib/broadcast-sync'
import { QueryClient } from '@tanstack/react-query'
import {
  applyTheme,
  readStoredPreference,
  setThemePreference,
  THEME_STORAGE_KEY,
} from '@/lib/theme'

afterEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  delete document.documentElement.dataset.openagentdAppId
  delete document.documentElement.dataset.openagentdWindowId
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
})

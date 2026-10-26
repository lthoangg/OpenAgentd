import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let isTauri = true
let os = 'macos'
const invokes: Array<{ command: string; args: unknown }> = []

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri, os, isMacOverlay: false, isFullscreen: false }),
  getPlatform: () => ({ isTauri, os, isMacOverlay: false, isFullscreen: false }),
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => {
    invokes.push({ command, args })
    return Promise.resolve(null)
  },
}))

const { initTheme, setThemePreference } = await import('@/lib/theme')

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function inAppWindow(id: string | undefined) {
  window.__OAD_APP_ID__ = 'com.openagentd.desktop'
  if (id) window.__OAD_WINDOW_ID__ = id
}

beforeEach(() => {
  isTauri = true
  os = 'macos'
  invokes.length = 0
  inAppWindow('main')
})

afterEach(() => {
  localStorage.clear()
  delete window.__OAD_APP_ID__
  delete window.__OAD_WINDOW_ID__
  document.documentElement.classList.remove('dark', 'light')
})

describe('desktop window background follows the theme preference', () => {
  it('tells the shell about an explicit pick', async () => {
    setThemePreference('dark')
    await flush()

    expect(invokes).toEqual([{ command: 'set_window_theme', args: { preference: 'dark' } }])
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('reports the stored preference when the page starts', async () => {
    setThemePreference('light')
    await flush()
    invokes.length = 0

    const stop = initTheme()
    await flush()
    stop()

    expect(invokes).toEqual([{ command: 'set_window_theme', args: { preference: 'light' } }])
  })

  it('stays quiet in browsers', async () => {
    isTauri = false
    setThemePreference('dark')
    await flush()

    expect(invokes).toEqual([])
  })

  it('stays quiet in windows without an app window id (tray, island)', async () => {
    delete window.__OAD_WINDOW_ID__
    setThemePreference('dark')
    await flush()

    expect(invokes).toEqual([])
  })
})

describe('mobile shells follow the theme preference', () => {
  it('tells the iOS shell, which has no window id', async () => {
    os = 'ios'
    delete window.__OAD_WINDOW_ID__
    setThemePreference('dark')
    await flush()

    expect(invokes).toEqual([{ command: 'set_app_theme', args: { preference: 'dark' } }])
  })

  it('tells the Android shell when the page starts', async () => {
    os = 'android'
    setThemePreference('system')
    await flush()
    invokes.length = 0

    const stop = initTheme()
    await flush()
    stop()

    expect(invokes).toEqual([{ command: 'set_app_theme', args: { preference: 'system' } }])
  })

  it('stays quiet in mobile browsers', async () => {
    os = 'ios'
    isTauri = false
    setThemePreference('dark')
    await flush()

    expect(invokes).toEqual([])
  })
})

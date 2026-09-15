/**
 * Guards `web/public/theme-init.js` — the inline pre-paint script. It runs
 * before any module, so it cannot import `@/lib/theme`; the two duplicate the
 * window-identity resolution and storage-key shape and must stay in sync.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'

const SCRIPT = readFileSync(
  new URL('../../../public/theme-init.js', import.meta.url),
  'utf8',
)

function runThemeInit(): void {
  // `runInThisContext` executes the script against the current realm's
  // globals, so its `window` / `document` / `localStorage` references hit the
  // happy-dom globals that `GlobalRegistrator` installs.
  runInThisContext(SCRIPT)
}

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  document.documentElement.classList.remove('dark', 'light')
  delete document.documentElement.dataset.openagentdAppId
  delete document.documentElement.dataset.openagentdWindowId
  delete window.__OAD_APP_ID__
  delete window.__OAD_WINDOW_ID__
})

afterEach(() => {
  localStorage.clear()
  delete window.__OAD_APP_ID__
  delete window.__OAD_WINDOW_ID__
})

describe('theme-init pre-paint script', () => {
  it('uses the injected identity when the URL has no params (reload)', () => {
    window.__OAD_APP_ID__ = 'com.openagentd.desktop'
    window.__OAD_WINDOW_ID__ = 'main-2'
    localStorage.setItem('oa-theme:com.openagentd.desktop:main-2', 'dark')

    runThemeInit()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.openagentdAppId).toBe('com.openagentd.desktop')
    expect(document.documentElement.dataset.openagentdWindowId).toBe('main-2')
  })

  it('falls back to the URL params when no identity is injected', () => {
    history.replaceState(null, '', '/index.html?oa-app-id=com.openagentd.desktop&oa-window-id=main')
    localStorage.setItem('oa-theme:com.openagentd.desktop:main', 'dark')

    runThemeInit()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.openagentdWindowId).toBe('main')
  })

  it('does not read another window scope', () => {
    window.__OAD_APP_ID__ = 'com.openagentd.desktop'
    window.__OAD_WINDOW_ID__ = 'main-3'
    localStorage.setItem('oa-theme:com.openagentd.desktop:main-2', 'dark')

    runThemeInit()

    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

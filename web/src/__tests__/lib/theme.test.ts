import { afterEach, describe, expect, it } from 'bun:test'
import { applyTheme, initTheme, THEME_STORAGE_KEY } from '@/lib/theme'

afterEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY)
  document.documentElement.classList.remove('dark', 'light')
  document.querySelector('meta[name="theme-color"][data-openagentd-theme]')?.remove()
})

describe('theme', () => {
  it('syncs another app window when the stored preference changes', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const cleanup = initTheme()

    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }))

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    cleanup()
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
})

import { afterEach, describe, expect, it } from 'bun:test'
import { applyTheme } from '@/lib/theme'

afterEach(() => {
  document.documentElement.classList.remove('dark', 'light')
  document.querySelector('meta[name="theme-color"][data-openagentd-theme]')?.remove()
})

describe('theme', () => {
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

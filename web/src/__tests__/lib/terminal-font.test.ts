/**
 * terminal-font — the terminal's fixed font stack and size. The custom font
 * and size went with the Terminal settings page; what it stored is cleared.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  BUNDLED_ICONS_FAMILY,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  clearRetiredTerminalFontPrefs,
} from '@/lib/terminal-font'

afterEach(() => {
  localStorage.clear()
})

describe('TERMINAL_FONT_FAMILY', () => {
  it('starts with the Nerd Font guesses, MesloLGS NF first', () => {
    expect(TERMINAL_FONT_FAMILY.startsWith('"MesloLGS NF", ')).toBe(true)
    expect(TERMINAL_FONT_FAMILY).toContain('"JetBrains Mono Variable"')
  })

  it('carries the bundled icons family once, after the guesses and before the generic tail (prompt icons on mobile)', () => {
    const bundled = TERMINAL_FONT_FAMILY.indexOf(`"${BUNDLED_ICONS_FAMILY}"`)
    expect(TERMINAL_FONT_FAMILY.split(`"${BUNDLED_ICONS_FAMILY}"`)).toHaveLength(2)
    expect(bundled).toBeGreaterThan(TERMINAL_FONT_FAMILY.indexOf('"JetBrains Mono Variable"'))
    expect(bundled).toBeLessThan(TERMINAL_FONT_FAMILY.indexOf('ui-monospace'))
    expect(TERMINAL_FONT_FAMILY.endsWith('monospace')).toBe(true)
  })

  it('is 13 px', () => {
    expect(TERMINAL_FONT_SIZE).toBe(13)
  })
})

describe('clearRetiredTerminalFontPrefs', () => {
  it('drops the font and size the retired settings page stored, and nothing else', () => {
    localStorage.setItem('oa-terminal-font', 'Hack Nerd Font')
    localStorage.setItem('oa-terminal-font-size', '20')
    localStorage.setItem('oa-unrelated', 'keep')
    clearRetiredTerminalFontPrefs()
    expect(localStorage.getItem('oa-terminal-font')).toBeNull()
    expect(localStorage.getItem('oa-terminal-font-size')).toBeNull()
    expect(localStorage.getItem('oa-unrelated')).toBe('keep')
  })
})

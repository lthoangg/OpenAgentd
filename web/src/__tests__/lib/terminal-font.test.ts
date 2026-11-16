/**
 * terminal-font — the terminal's fixed font stack, and its size per Text size.
 */
import { describe, expect, it } from 'bun:test'
import {
  BUNDLED_ICONS_FAMILY,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  terminalFontSize,
} from '@/lib/terminal-font'

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

  it('is 13 px at the default Text size', () => {
    expect(TERMINAL_FONT_SIZE).toBe(13)
  })

  it('follows Text size: Compact 12, Default 13, Large 14', () => {
    expect([terminalFontSize('compact'), terminalFontSize('default'), terminalFontSize('large')]).toEqual([12, 13, 14])
  })
})

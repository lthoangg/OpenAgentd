/**
 * terminal-font — user-configurable terminal font with live availability
 * checking.
 *
 * Browsers/webviews deliberately do not expose the system's installed font
 * list (fingerprinting risk), so we can't auto-detect "the user has Meslo
 * installed" the way a native app could. The dynamic part is: the user
 * types the exact font name they have installed (MesloLGS NF, Hack Nerd
 * Font, JetBrainsMono Nerd Font, ...), we verify it actually resolves via
 * `document.fonts.check()`, and every live terminal's `fontFamily` updates
 * immediately — no restart, no guessing from a fixed list.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  TERMINAL_FONT_STORAGE_KEY,
  buildTerminalFontFamily,
  isFontAvailable,
  readStoredTerminalFont,
  setStoredTerminalFont,
} from '@/lib/terminal-font'

afterEach(() => {
  localStorage.removeItem(TERMINAL_FONT_STORAGE_KEY)
})

describe('buildTerminalFontFamily', () => {
  it('puts a custom font first, quoted, ahead of the Nerd Font fallback stack', () => {
    const stack = buildTerminalFontFamily('MesloLGS NF')
    expect(stack.startsWith('"MesloLGS NF", ')).toBe(true)
    // Still carries the built-in fallbacks so an unresolved custom name
    // degrades gracefully instead of falling straight to a non-monospace
    // browser default.
    expect(stack).toContain('"JetBrains Mono Variable"')
  })

  it('deduplicates when the custom font matches a name already in the fallback stack', () => {
    const stack = buildTerminalFontFamily('JetBrainsMono Nerd Font')
    const occurrences = stack.split('"JetBrainsMono Nerd Font"').length - 1
    expect(occurrences).toBe(1)
  })

  it('quotes a font name containing spaces exactly once', () => {
    const stack = buildTerminalFontFamily('Hack Nerd Font Mono')
    expect(stack).toContain('"Hack Nerd Font Mono"')
    expect(stack).not.toContain('""Hack Nerd Font Mono""')
  })

  it('falls back to the plain Nerd-Font-guess stack when no custom font is set', () => {
    const stack = buildTerminalFontFamily(null)
    expect(stack.startsWith('"MesloLGS NF"')).toBe(true)
  })

  it('ignores a blank/whitespace-only custom font', () => {
    expect(buildTerminalFontFamily('   ')).toBe(buildTerminalFontFamily(null))
  })
})

describe('readStoredTerminalFont / setStoredTerminalFont', () => {
  it('round-trips a stored font name', () => {
    setStoredTerminalFont('MesloLGS NF')
    expect(readStoredTerminalFont()).toBe('MesloLGS NF')
  })

  it('clearing with null removes the stored preference', () => {
    setStoredTerminalFont('MesloLGS NF')
    setStoredTerminalFont(null)
    expect(readStoredTerminalFont()).toBeNull()
  })

  it('returns null when nothing has been stored', () => {
    expect(readStoredTerminalFont()).toBeNull()
  })

  it('trims whitespace before storing and treats blank as clearing', () => {
    setStoredTerminalFont('  Hack Nerd Font  ')
    expect(readStoredTerminalFont()).toBe('Hack Nerd Font')
    setStoredTerminalFont('   ')
    expect(readStoredTerminalFont()).toBeNull()
  })
})

describe('isFontAvailable', () => {
  it('returns true when document.fonts.check resolves the name', () => {
    const fakeFonts = { check: (spec: string) => spec.includes('Meslo') } as unknown as FontFaceSet
    expect(isFontAvailable('MesloLGS NF', fakeFonts)).toBe(true)
  })

  it('returns false when document.fonts.check does not resolve the name', () => {
    const fakeFonts = { check: () => false } as unknown as FontFaceSet
    expect(isFontAvailable('Nonexistent Font', fakeFonts)).toBe(false)
  })

  it('returns null (unknown) when the Font Loading API is unavailable', () => {
    expect(isFontAvailable('MesloLGS NF', undefined)).toBeNull()
  })
})

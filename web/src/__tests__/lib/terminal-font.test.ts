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

/** The CSS family name declared in our bundled @font-face block. */
const BUNDLED_ICONS_FAMILY = 'Symbols Nerd Font Mono'

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

  // ── Bundled icons-only font fallback (mobile fix) ──────────────────────────

  it('always includes the bundled Nerd Font icons family in the stack', () => {
    // With no custom font — bundled fallback must be present
    expect(buildTerminalFontFamily(null)).toContain(`"${BUNDLED_ICONS_FAMILY}"`)
    // With a custom font — bundled fallback still present
    expect(buildTerminalFontFamily('MesloLGS NF')).toContain(`"${BUNDLED_ICONS_FAMILY}"`)
  })

  it('places the bundled icons family before the generic monospace tail', () => {
    const stack = buildTerminalFontFamily(null)
    const bundledIdx = stack.indexOf(`"${BUNDLED_ICONS_FAMILY}"`)
    const tailIdx = stack.indexOf('ui-monospace')
    expect(bundledIdx).toBeGreaterThan(-1)
    expect(tailIdx).toBeGreaterThan(-1)
    expect(bundledIdx).toBeLessThan(tailIdx)
  })

  it('places the bundled icons family after the guess stack entries', () => {
    const stack = buildTerminalFontFamily(null)
    // JetBrains Mono Variable is the last entry in GUESS_STACK
    const lastGuessIdx = stack.indexOf('"JetBrains Mono Variable"')
    const bundledIdx = stack.indexOf(`"${BUNDLED_ICONS_FAMILY}"`)
    expect(lastGuessIdx).toBeGreaterThan(-1)
    expect(bundledIdx).toBeGreaterThan(lastGuessIdx)
  })

  it('does not duplicate the bundled family when the user sets it as their custom font', () => {
    const stack = buildTerminalFontFamily(BUNDLED_ICONS_FAMILY)
    const occurrences = stack.split(`"${BUNDLED_ICONS_FAMILY}"`).length - 1
    expect(occurrences).toBe(1)
  })

  it('does not duplicate the bundled family when it appears in the guess stack', () => {
    // Symbols Nerd Font Mono is already in GUESS_STACK — the bundled fallback
    // logic must not add a second copy.
    const stack = buildTerminalFontFamily(null)
    const occurrences = stack.split(`"${BUNDLED_ICONS_FAMILY}"`).length - 1
    expect(occurrences).toBe(1)
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

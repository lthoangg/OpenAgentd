/**
 * terminal-font — user-configurable terminal font, with live availability
 * checking against fonts actually installed on the user's machine.
 *
 * Why this can't be fully automatic: browsers/webviews deliberately don't
 * expose the OS's installed font list (it's a fingerprinting vector), so
 * there's no API to enumerate "which Nerd Font does this user have". What
 * we CAN do:
 *   1. Ship a best-guess fallback stack of the most common Nerd Font names
 *      (MesloLGS NF — p10k's own recommendation — plus a few others) so
 *      many users get working glyphs with zero configuration.
 *   2. Let the user type the *exact* name of whatever they installed
 *      (Settings → Terminal), verify it actually resolves in this browser/
 *      webview via the Font Loading API (`document.fonts.check`), and put
 *      it first in the stack — covering every Nerd Font variant, not just
 *      the ones we guessed.
 *
 * The custom font (if set) is layered ON TOP of the guess stack, not a
 * replacement for it — an unresolved/typo'd custom name still degrades to
 * the guess stack instead of jumping straight to a non-monospace default.
 */

const STORAGE_KEY_PREFIX = 'oa-terminal-font'
export const TERMINAL_FONT_STORAGE_KEY = STORAGE_KEY_PREFIX

const FONT_CHANGE_EVENT = 'oa-terminal-font-change'

/** Best-guess Nerd Font names, most-recommended first (p10k docs → MesloLGS NF). */
const GUESS_STACK = [
  'MesloLGS NF',
  'JetBrainsMono Nerd Font',
  'JetBrainsMono NF',
  'Hack Nerd Font',
  'FiraCode Nerd Font',
  'JetBrains Mono Variable',
] as const

/**
 * The CSS family name of our bundled icons-only Nerd Font (Symbols Nerd Font
 * Mono, OFL-1.1). Declared via @font-face in assets/fonts/nerd-font-icons.css
 * with unicode-range scoping so it's fetched lazily only when a PUA icon
 * glyph is actually needed.
 *
 * This is the mobile fix: on iOS/Android WebViews the OS never exposes
 * installed fonts to the webview, so every GUESS_STACK entry fails and PUA
 * glyphs (p10k/Starship folder, git, branch icons) render as boxes. The
 * bundled family guarantees working icon glyphs on every platform without
 * requiring any user action. On desktop it sits after the guess stack so any
 * real installed Nerd Font still wins.
 */
const BUNDLED_ICONS_FAMILY = 'Symbols Nerd Font Mono'

const GENERIC_TAIL = 'ui-monospace, SFMono-Regular, Menlo, monospace'

function quote(fontName: string): string {
  return `"${fontName}"`
}

/**
 * Build the CSS `font-family` value xterm.js should use.
 *
 * Stack order (highest → lowest priority):
 *   1. User's custom font (if set in Settings → Terminal) — desktop precision path.
 *   2. GUESS_STACK — common Nerd Font family names; resolves on desktop if installed.
 *   3. BUNDLED_ICONS_FAMILY — our bundled Symbols Nerd Font Mono (@font-face,
 *      unicode-range scoped to PUA icon blocks). Always resolves; guarantees
 *      working p10k/Starship icon glyphs on mobile where no OS font is visible.
 *   4. GENERIC_TAIL — ui-monospace et al.; last-resort text fallback.
 *
 * Dedup: if the custom font or a guess matches BUNDLED_ICONS_FAMILY by name,
 * the bundled entry is dropped from its dedicated position (it's already present
 * earlier in the stack).
 */
export function buildTerminalFontFamily(customFont: string | null): string {
  const trimmed = customFont?.trim()

  // Remove the custom font from the guess stack if it duplicates an entry.
  const guesses = trimmed
    ? GUESS_STACK.filter((name) => name.toLowerCase() !== trimmed.toLowerCase())
    : GUESS_STACK

  const names = trimmed ? [trimmed, ...guesses] : [...guesses]

  // Append the bundled icons fallback after the guess stack unless it's already
  // present (because the user typed it as their custom font, or it remains in a
  // future guess stack update).
  const namesLower = names.map((n) => n.toLowerCase())
  const bundledAlreadyPresent = namesLower.includes(BUNDLED_ICONS_FAMILY.toLowerCase())
  const allNames = bundledAlreadyPresent ? names : [...names, BUNDLED_ICONS_FAMILY]

  return [...allNames.map(quote), GENERIC_TAIL].join(', ')
}

function isBlank(value: string | null): value is null {
  return value === null || value.trim() === ''
}

export function readStoredTerminalFont(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX)
    return isBlank(raw) ? null : raw
  } catch {
    // localStorage unavailable (SSR, privacy mode).
    return null
  }
}

/** Store the custom font; blank/whitespace-only clears the preference. */
export function setStoredTerminalFont(font: string | null): void {
  const trimmed = font?.trim()
  try {
    if (isBlank(trimmed ?? null)) {
      localStorage.removeItem(STORAGE_KEY_PREFIX)
    } else {
      localStorage.setItem(STORAGE_KEY_PREFIX, trimmed as string)
    }
  } catch {
    // best-effort — still notify listeners below
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FONT_CHANGE_EVENT))
  }
}

export function onTerminalFontChange(handler: () => void): () => void {
  window.addEventListener(FONT_CHANGE_EVENT, handler)
  return () => window.removeEventListener(FONT_CHANGE_EVENT, handler)
}

export const DEFAULT_TERMINAL_FONT_SIZE = 13
export const MIN_TERMINAL_FONT_SIZE = 9
export const MAX_TERMINAL_FONT_SIZE = 24

const STORAGE_KEY_FONT_SIZE = 'oa-terminal-font-size'
const FONT_SIZE_CHANGE_EVENT = 'oa-terminal-font-size-change'

export function readStoredTerminalFontSize(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FONT_SIZE)
    if (!raw) return DEFAULT_TERMINAL_FONT_SIZE
    const val = Number.parseInt(raw, 10)
    if (Number.isNaN(val)) return DEFAULT_TERMINAL_FONT_SIZE
    return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(val, MAX_TERMINAL_FONT_SIZE))
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE
  }
}

export function setStoredTerminalFontSize(size: number): void {
  const clamped = Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(size, MAX_TERMINAL_FONT_SIZE))
  try {
    localStorage.setItem(STORAGE_KEY_FONT_SIZE, String(clamped))
  } catch {
    // best-effort — still notify listeners below
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FONT_SIZE_CHANGE_EVENT))
  }
}

export function onTerminalFontSizeChange(handler: () => void): () => void {
  window.addEventListener(FONT_SIZE_CHANGE_EVENT, handler)
  return () => window.removeEventListener(FONT_SIZE_CHANGE_EVENT, handler)
}

/**
 * Check whether *fontName* actually resolves to an installed font in this
 * browser/webview, using the Font Loading API. Returns:
 *   - `true`/`false` — a definitive answer.
 *   - `null` — the API is unavailable (older WebView) and availability is
 *     simply unknown; callers should not block on this.
 *
 * `fontsApi` is injectable for testing; defaults to `document.fonts`.
 */
export function isFontAvailable(
  fontName: string,
  fontsApi: FontFaceSet | undefined = typeof document !== 'undefined' ? document.fonts : undefined,
): boolean | null {
  if (!fontsApi || typeof fontsApi.check !== 'function') return null
  try {
    // A representative size/style probe — the actual terminal font size
    // doesn't affect whether the family name resolves.
    return fontsApi.check(`16px "${fontName}"`)
  } catch {
    return null
  }
}

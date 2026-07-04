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
  'Symbols Nerd Font Mono',
  'JetBrains Mono Variable',
] as const

const GENERIC_TAIL = 'ui-monospace, SFMono-Regular, Menlo, monospace'

function quote(fontName: string): string {
  return `"${fontName}"`
}

/**
 * Build the CSS `font-family` value xterm.js should use: the user's custom
 * font (if any and non-blank) first, then the built-in guess stack (minus
 * a duplicate if the custom font matches one of the guesses), then generic
 * monospace fallbacks.
 */
export function buildTerminalFontFamily(customFont: string | null): string {
  const trimmed = customFont?.trim()
  const guesses = trimmed
    ? GUESS_STACK.filter((name) => name.toLowerCase() !== trimmed.toLowerCase())
    : GUESS_STACK
  const names = trimmed ? [trimmed, ...guesses] : [...guesses]
  return [...names.map(quote), GENERIC_TAIL].join(', ')
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

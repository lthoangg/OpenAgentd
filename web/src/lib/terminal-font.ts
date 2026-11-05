/**
 * terminal-font — the terminal's font stack and size. Both are fixed: the
 * custom font and size went with the Terminal settings page, and the
 * values that page stored are cleared (``clearRetiredTerminalFontPrefs``).
 *
 * Browsers and webviews do not expose the OS's installed font list (it is a
 * fingerprinting vector), so the stack guesses: the most common Nerd Font
 * names first (MesloLGS NF is Powerlevel10k's own recommendation), then a
 * bundled icons-only Nerd Font, then the system monospace fonts.
 */

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
export const BUNDLED_ICONS_FAMILY = 'Symbols Nerd Font Mono'

const GENERIC_TAIL = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/**
 * The CSS `font-family` xterm.js uses, highest priority first: the Nerd Font
 * guesses (resolve on a desktop that has one), the bundled icons family
 * (always resolves, so prompt icons work on mobile too), then the generic
 * monospace fallbacks.
 */
export const TERMINAL_FONT_FAMILY = [...GUESS_STACK, BUNDLED_ICONS_FAMILY].map((name) => `"${name}"`).concat(GENERIC_TAIL).join(', ')

export const TERMINAL_FONT_SIZE = 13

/** What the retired Terminal settings page stored. */
const RETIRED_KEYS = ['oa-terminal-font', 'oa-terminal-font-size'] as const

/**
 * Drop the font and size the retired Terminal settings page stored: nothing
 * reads them, and nothing could change them any more.
 */
export function clearRetiredTerminalFontPrefs(): void {
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key)
  } catch {
    // localStorage unavailable (SSR, privacy mode): nothing to clear.
  }
}

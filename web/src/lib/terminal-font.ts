/**
 * terminal-font — the terminal's font stack (fixed) and size (the app's
 * Text size setting, so the terminal reads at the size the app does).
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
import type { TextSize } from '@/stores/useDisplayPrefsStore'

export const BUNDLED_ICONS_FAMILY = 'Symbols Nerd Font Mono'

const GENERIC_TAIL = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/**
 * The CSS `font-family` xterm.js uses, highest priority first: the Nerd Font
 * guesses (resolve on a desktop that has one), the bundled icons family
 * (always resolves, so prompt icons work on mobile too), then the generic
 * monospace fallbacks.
 */
export const TERMINAL_FONT_FAMILY = [...GUESS_STACK, BUNDLED_ICONS_FAMILY].map((name) => `"${name}"`).concat(GENERIC_TAIL).join(', ')

/** Terminal px per Text size: the desktop UI's own sizes, Default at 13. */
const TERMINAL_FONT_SIZES: Record<TextSize, number> = { compact: 12, default: 13, large: 14 }

export const TERMINAL_FONT_SIZE = TERMINAL_FONT_SIZES.default

export function terminalFontSize(size: TextSize): number {
  return TERMINAL_FONT_SIZES[size]
}

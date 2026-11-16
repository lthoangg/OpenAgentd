/**
 * Sticky Ctrl and Alt for touch: the key bar arms a modifier, and the next
 * key (from the soft keyboard or the bar itself) is sent with it, the way a
 * terminal sends a real chord.
 *
 * - A character: Ctrl makes it a control code (a–z → 0x01–0x1a, plus
 *   [ \ ] ^ _ ? @); Alt puts ESC before it (Meta-sends-Escape, what readline
 *   and Emacs bindings expect: Alt+b, Alt+f, Alt+.).
 * - An arrow, Home or End (``ESC [ A`` or ``ESC O A``) becomes
 *   ``ESC [ 1 ; m A``, and PgUp/PgDn (``ESC [ 5 ~``) ``ESC [ 5 ; m ~``,
 *   with xterm's modifier number m = 1 + 2 (Alt) + 4 (Ctrl).
 *
 * Anything else (a paste, a word the keyboard committed) is not a key:
 * ``null`` leaves it as typed and the modifier armed.
 */

export interface StickyModifiers {
  ctrl: boolean
  alt: boolean
}

const ESC = '\x1b'
const CURSOR_FINALS = new Set(['A', 'B', 'C', 'D', 'H', 'F'])

/** The final letter of ``ESC [ X`` / ``ESC O X`` for an arrow, Home or End. */
function cursorKey(data: string): string | null {
  if (data.length !== 3 || data[0] !== ESC || (data[1] !== '[' && data[1] !== 'O')) return null
  return CURSOR_FINALS.has(data[2]!) ? data[2]! : null
}

/** The number of ``ESC [ n ~`` (PgUp is 5, PgDn 6). */
function tildeKey(data: string): string | null {
  if (!data.startsWith(`${ESC}[`) || !data.endsWith('~')) return null
  const number = data.slice(2, -1)
  return /^\d+$/.test(number) ? number : null
}

function controlCode(ch: string): string {
  const lower = ch.toLowerCase()
  const code = lower.charCodeAt(0)
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
  if (lower === '[') return '\x1b'
  if (lower === '\\') return '\x1c'
  if (lower === ']') return '\x1d'
  if (lower === '^') return '\x1e'
  if (lower === '_') return '\x1f'
  if (lower === '?') return '\x7f'
  if (lower === '@' || lower === '0') return '\x00'
  return ch
}

/** ``data`` sent with the armed modifiers, or ``null`` when it is not one key. */
export function applyModifiers(data: string, mods: StickyModifiers): string | null {
  if (!mods.ctrl && !mods.alt) return data
  const param = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
  const cursor = cursorKey(data)
  if (cursor) return `${ESC}[1;${param}${cursor}`
  const tilde = tildeKey(data)
  if (tilde) return `${ESC}[${tilde};${param}~`
  // One key: a character, or Esc/Tab/a control code from the bar.
  if (data.length !== 1) return null
  const base = mods.ctrl ? controlCode(data) : data
  return mods.alt ? `${ESC}${base}` : base
}

/**
 * The terminal's input transform for sticky modifiers: a key goes out with
 * the armed modifiers, which then ``release``; other input passes as typed.
 */
export function stickyModifierTransform(armed: () => StickyModifiers, release: () => void): (data: string) => string {
  return (data) => {
    const mods = armed()
    if (!mods.ctrl && !mods.alt) return data
    const sent = applyModifiers(data, mods)
    if (sent === null) return data
    release()
    return sent
  }
}

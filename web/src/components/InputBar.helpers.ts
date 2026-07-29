export const CHAR_WARN_THRESHOLD = 500

export function findActiveSnippet(text: string, caret: number) {
  const hash = text.lastIndexOf('#', Math.max(0, caret - 1))
  if (hash === -1) return null
  const token = text.slice(hash + 1, caret)
  if (/\s/.test(token)) return null
  return { start: hash, end: caret, query: token.toLowerCase() }
}

// NOTE: word-by-word caret navigation (Alt/Ctrl+Arrow) is intentionally NOT
// implemented here — the browser's native textarea behaviour handles it, and
// mention-picker sync is covered by the textarea's `onSelect` handler.

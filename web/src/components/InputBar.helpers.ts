export const CHAR_WARN_THRESHOLD = 500

export function findActiveSnippet(text: string, caret: number) {
  const hash = text.lastIndexOf('#', Math.max(0, caret - 1))
  if (hash === -1) return null
  const token = text.slice(hash + 1, caret)
  if (/\s/.test(token)) return null
  return { start: hash, end: caret, query: token.toLowerCase() }
}

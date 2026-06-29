export const CHAR_WARN_THRESHOLD = 500

export function findActiveSnippet(text: string, caret: number) {
  const hash = text.lastIndexOf('#', Math.max(0, caret - 1))
  if (hash === -1) return null
  const token = text.slice(hash + 1, caret)
  if (/\s/.test(token)) return null
  return { start: hash, end: caret, query: token.toLowerCase() }
}

export function getPreviousWordBoundary(text: string, index: number): number {
  if (index <= 0) return 0

  let i = index

  const isWhitespace = (char: string) => /\s/.test(char)
  const isWordChar = (char: string) => /[\p{L}\p{N}_]/u.test(char)

  // 1. Skip any whitespace to the left
  while (i > 0 && isWhitespace(text[i - 1])) {
    i--
  }

  if (i === 0) return 0

  // 2. Determine if the character to the left is a word character or separator
  const isWord = isWordChar(text[i - 1])

  if (isWord) {
    while (i > 0 && isWordChar(text[i - 1])) {
      i--
    }
  } else {
    while (i > 0 && !isWordChar(text[i - 1]) && !isWhitespace(text[i - 1])) {
      i--
    }
    while (i > 0 && isWordChar(text[i - 1])) {
      i--
    }
  }

  return i
}

export function getNextWordBoundary(text: string, index: number): number {
  const len = text.length
  if (index >= len) return len

  let i = index

  const isWhitespace = (char: string) => /\s/.test(char)
  const isWordChar = (char: string) => /[\p{L}\p{N}_]/u.test(char)

  // 1. Skip any whitespace to the right
  while (i < len && isWhitespace(text[i])) {
    i++
  }

  if (i === len) return len

  // 2. Determine if the character is a word character or separator
  const isWord = isWordChar(text[i])

  if (isWord) {
    while (i < len && isWordChar(text[i])) {
      i++
    }
  } else {
    while (i < len && !isWordChar(text[i]) && !isWhitespace(text[i])) {
      i++
    }
    while (i < len && isWordChar(text[i])) {
      i++
    }
  }

  return i
}

export function handleWordNavigation(
  el: HTMLTextAreaElement,
  direction: 'left' | 'right',
  select: boolean,
) {
  const text = el.value
  const start = el.selectionStart
  const end = el.selectionEnd
  const selDir = el.selectionDirection

  let activeCursor = direction === 'left' ? start : end
  if (select && selDir === 'backward') {
    activeCursor = start
  } else if (select && selDir === 'forward') {
    activeCursor = end
  } else if (select && start !== end) {
    activeCursor = direction === 'left' ? start : end
  }

  const newCursor = direction === 'left'
    ? getPreviousWordBoundary(text, activeCursor)
    : getNextWordBoundary(text, activeCursor)

  if (select) {
    if (start === end) {
      if (direction === 'left') {
        el.setSelectionRange(newCursor, start, 'backward')
      } else {
        el.setSelectionRange(start, newCursor, 'forward')
      }
    } else {
      if (selDir === 'backward') {
        if (newCursor > end) {
          el.setSelectionRange(end, newCursor, 'forward')
        } else {
          el.setSelectionRange(newCursor, end, 'backward')
        }
      } else {
        if (newCursor < start) {
          el.setSelectionRange(newCursor, start, 'backward')
        } else {
          el.setSelectionRange(start, newCursor, 'forward')
        }
      }
    }
  } else {
    el.setSelectionRange(newCursor, newCursor)
  }
}

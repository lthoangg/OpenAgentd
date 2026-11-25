/**
 * A `grep` result read as lines: matches (`file:12: text`), the lines shown
 * around them when the call asked for context (`file-12- text`), the `--`
 * between groups, and the closing note about matches left out.
 */

export interface SearchLine {
  kind: 'match' | 'context' | 'gap' | 'text'
  text: string
}

export interface ParsedSearchResult {
  lines: SearchLine[]
  matches: number
  /** The closing note without its brackets. */
  note: string | null
}

const NOTE = /\n\n\[([^\n]*)\]\s*$/
// The path comes first, so the first line number in a line is the line's
// own; one further along is code that happens to look like it.
const LINE_NUMBER = /:(\d+): |-(\d+)- /

function kindOf(line: string): SearchLine['kind'] {
  if (line === '--') return 'gap'
  const found = LINE_NUMBER.exec(line)
  if (!found || found.index === 0) return 'text'
  return found[1] !== undefined ? 'match' : 'context'
}

/** Null when no line is a match: a list of paths, or "No matches…". */
export function parseSearchResult(result: string): ParsedSearchResult | null {
  const note = NOTE.exec(result)
  const body = note ? result.slice(0, note.index) : result
  const lines = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((text) => ({ kind: kindOf(text), text }))
  const matches = lines.filter((line) => line.kind === 'match').length
  if (matches === 0) return null
  return { lines, matches, note: note ? note[1] : null }
}

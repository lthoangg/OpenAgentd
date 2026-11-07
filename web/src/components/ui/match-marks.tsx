/**
 * The matched text of a search, marked where it is drawn: the sidebar's
 * session search and the command palette's rows.
 */
import type { ReactNode } from 'react'

/** The mark itself: the find highlight's soft orange, in the text's own colour. */
export const MATCH_MARK_CLASS = 'rounded-xs bg-(--accent-orange-soft) px-px font-semibold text-inherit'

/**
 * Where ``words`` occur in ``text`` (case-insensitive), merged where they
 * overlap or touch, in order. Empty when a case fold changes the length
 * (rare scripts), which would misplace the marks.
 */
export function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const lower = text.toLowerCase()
  if (lower.length !== text.length) return []
  const found: [number, number][] = []
  for (const word of words) {
    const needle = word.toLowerCase()
    if (!needle) continue
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      found.push([at, at + needle.length])
    }
  }
  found.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of found) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

/**
 * ``text`` with its matches marked. The marked copy is drawn and hidden from
 * assistive tech, which reads the plain text instead, so no reader hears a
 * word split at its mark.
 */
export function MatchMarks({ text, words }: { text: string; words: readonly string[] }) {
  const ranges = matchRanges(text, words)
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let from = 0
  for (const [start, end] of ranges) {
    if (start > from) parts.push(text.slice(from, start))
    parts.push(<mark key={start} className={MATCH_MARK_CLASS}>{text.slice(start, end)}</mark>)
    from = end
  }
  if (from < text.length) parts.push(text.slice(from))
  return (
    <>
      <span aria-hidden="true">{parts}</span>
      <span className="sr-only">{text}</span>
    </>
  )
}

/**
 * Titles the server generated (``title_update``), so the places that show a
 * title can animate it landing — and only it: a rename the user typed, a
 * list load and a session switch all swap the text without motion.
 *
 * A mark holds the exact title for a short window; a view that renders that
 * title for that session within it plays the arrival once.
 */
const WINDOW_MS = 2000

const marks = new Map<string, { title: string; at: number }>()

export function markAutoTitle(sessionId: string, title: string, now = Date.now()): void {
  marks.set(sessionId, { title, at: now })
}

export function isFreshAutoTitle(sessionId: string | null | undefined, title: string | null | undefined, now = Date.now()): boolean {
  if (!sessionId || !title) return false
  const mark = marks.get(sessionId)
  return mark !== undefined && mark.title === title && now - mark.at <= WINDOW_MS
}

export function _resetAutoTitlesForTests(): void {
  marks.clear()
}

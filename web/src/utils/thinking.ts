/**
 * Helpers for the inline ``Thinking`` reasoning-trace component.
 *
 * Reasoning streams from providers like OpenAI's ``/responses`` API as a
 * sequence of sections, each beginning with a bold ``**Title**`` header.
 * The backend joins these sections with a blank line; this helper parses
 * the resulting text into ordered sections so the UI can style each
 * header above its own paragraph body.
 *
 * Kept in a separate module from ``Thinking.tsx`` so React Fast Refresh
 * is not disrupted by a non-component export (eslint plugin enforced).
 */

export interface ThinkingSection {
  /** Bold-header title, or ``null`` for prose with no preceding header. */
  header: string | null
  /** Body text below the header (possibly empty during streaming). */
  body: string
}

// Matches a bold header line: ``**Title**`` optionally surrounded by
// whitespace. Title is one line of non-asterisk, non-newline characters.
const HEADER_RE = /^\s*\*\*([^*\n]+)\*\*\s*$/gm

/** Runs of blank lines (Gemini joins chunks with "\n\n\n\n") become one
 *  paragraph break: the trace is shown with ``white-space: pre-wrap``. */
function tidy(body: string): string {
  return body.trim().replace(/\n[^\S\n]*(?:\n[^\S\n]*)+\n/g, '\n\n')
}

/**
 * Split reasoning text into ordered ``ThinkingSection``s.
 *
 * - Text before the first header (if any) becomes a leading section with
 *   ``header: null``.
 * - Each ``**Title**`` introduces a new section whose body extends to the
 *   next header or end of input.
 * - Empty sections (no header, no body) are dropped.
 * - Blank lines between paragraphs collapse to one.
 */
export function splitSections(content: string): ThinkingSection[] {
  const sections: ThinkingSection[] = []
  let lastIndex = 0
  let pendingHeader: string | null = null

  HEADER_RE.lastIndex = 0
  for (;;) {
    const match = HEADER_RE.exec(content)
    if (!match) break

    const body = tidy(content.slice(lastIndex, match.index))
    if (pendingHeader !== null || body) {
      sections.push({ header: pendingHeader, body })
    }
    pendingHeader = match[1].trim()
    lastIndex = match.index + match[0].length
  }

  const tail = tidy(content.slice(lastIndex))
  if (pendingHeader !== null || tail) {
    sections.push({ header: pendingHeader, body: tail })
  }

  return sections
}

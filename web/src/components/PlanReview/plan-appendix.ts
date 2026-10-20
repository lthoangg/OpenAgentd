/**
 * The plan's Appendix: everything from its first ``## Appendix`` heading on.
 * Plans keep implementation detail there, so the Plan panel shows it
 * collapsed under the reviewer-facing body. Headings inside code fences do
 * not count.
 */

export interface PlanParts {
  body: string
  /** The Appendix without its heading line, or ``null`` when there is none. */
  appendix: string | null
  /** The Appendix heading's text, e.g. "Appendix" or "Appendix: files". */
  title: string
  /** Its ``###`` sections, for the collapsed summary. */
  sections: string[]
}

const APPENDIX_HEADING = /^ {0,3}##\s+(appendix\b.*?)\s*#*\s*$/i
const SECTION_HEADING = /^ {0,3}###\s+(.+?)\s*#*\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

export function splitPlanAppendix(content: string): PlanParts {
  const lines = content.split('\n')
  let fence: string | null = null
  let at = -1
  let title = 'Appendix'
  for (let i = 0; i < lines.length; i++) {
    const marker = FENCE.exec(lines[i])?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = APPENDIX_HEADING.exec(lines[i])
    if (heading) {
      at = i
      title = heading[1]
      break
    }
  }
  if (at < 0) return { body: content, appendix: null, title, sections: [] }
  const rest = lines.slice(at + 1)
  const sections: string[] = []
  fence = null
  for (const line of rest) {
    const marker = FENCE.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    const section = fence === null ? SECTION_HEADING.exec(line) : null
    if (section) sections.push(section[1])
  }
  return {
    body: lines.slice(0, at).join('\n').trimEnd(),
    appendix: rest.join('\n').trim(),
    title,
    sections,
  }
}

const OPEN_KEY = 'oa.planAppendixOpen.v1:'

/** Whether the reader opened this session's Appendix (remembered per plan). */
export function readAppendixOpen(sessionId: string | null): boolean {
  if (!sessionId) return false
  try {
    return localStorage.getItem(OPEN_KEY + sessionId) === '1'
  } catch {
    return false
  }
}

export function writeAppendixOpen(sessionId: string | null, open: boolean): void {
  if (!sessionId) return
  try {
    if (open) localStorage.setItem(OPEN_KEY + sessionId, '1')
    else localStorage.removeItem(OPEN_KEY + sessionId)
  } catch {
    // Storage can be unavailable (private mode); the panel still works.
  }
}

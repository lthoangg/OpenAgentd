const MARK_ATTR = 'data-transcript-find'
const ACTIVE_ATTR = 'data-transcript-find-active'

export function clearTranscriptFindHighlight(root: ParentNode): void {
  const marks = [...root.querySelectorAll(`mark[${MARK_ATTR}]`)]
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    if (parent instanceof HTMLElement || parent instanceof DocumentFragment) {
      parent.normalize()
    }
  }
}

export function applyTranscriptFindHighlight(
  root: HTMLElement,
  rawQuery: string,
  activeIndex: number,
): HTMLElement | null {
  clearTranscriptFindHighlight(root)
  const query = rawQuery.trim()
  if (!query) return null
  const needle = query.toLowerCase()
  const marks: HTMLElement[] = []
  for (const block of root.querySelectorAll('[data-find-block]')) {
    highlightInNode(block, needle, marks)
  }
  if (marks.length === 0) return null
  const active = marks[((activeIndex % marks.length) + marks.length) % marks.length]
  active.setAttribute(ACTIVE_ATTR, '')
  return active
}

function collectTextNodes(root: Node, out: Text[]): void {
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.nodeValue) out.push(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const el = root as Element
  if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return
  for (const child of Array.from(root.childNodes)) collectTextNodes(child, out)
}

function highlightInNode(root: Node, needle: string, marks: HTMLElement[]): void {
  const textNodes: Text[] = []
  collectTextNodes(root, textNodes)
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? ''
    const lower = value.toLowerCase()
    const ranges: Array<{ start: number; end: number }> = []
    let from = 0
    while (from <= lower.length - needle.length) {
      const start = lower.indexOf(needle, from)
      if (start < 0) break
      ranges.push({ start, end: start + needle.length })
      from = start + needle.length
    }
    if (ranges.length === 0) continue
    wrapRanges(textNode, ranges, marks)
  }
}

function wrapRanges(
  textNode: Text,
  ranges: Array<{ start: number; end: number }>,
  marks: HTMLElement[],
): void {
  const value = textNode.nodeValue ?? ''
  const parent = textNode.parentNode
  if (!parent) return
  const frag = document.createDocumentFragment()
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) {
      frag.appendChild(document.createTextNode(value.slice(cursor, range.start)))
    }
    const mark = document.createElement('mark')
    mark.setAttribute(MARK_ATTR, '')
    mark.textContent = value.slice(range.start, range.end)
    frag.appendChild(mark)
    marks.push(mark)
    cursor = range.end
  }
  if (cursor < value.length) {
    frag.appendChild(document.createTextNode(value.slice(cursor)))
  }
  parent.replaceChild(frag, textNode)
}

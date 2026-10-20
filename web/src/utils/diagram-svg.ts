/**
 * Defense in depth for diagram SVG. Pele renders model-authored Mermaid to
 * SVG with its text escaped, links and images filtered, and no scripts or
 * event handlers; we render with links and images off on top of that. This
 * pass still drops anything active before the SVG reaches the page:
 * scripting and embedding elements, SMIL animation (which can rewrite an
 * ``href``), event-handler attributes, and any reference that is not an
 * in-document ``#fragment``.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

const BLOCKED_ELEMENTS = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'img', 'audio', 'video',
  'animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'handler', 'listener',
  'style', 'link', 'meta', 'base', 'html', 'body',
])

const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'data'])

function cleanElement(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase()
    const value = attr.value.trim()
    if (name.startsWith('on')) el.removeAttribute(attr.name)
    else if (URL_ATTRIBUTES.has(name) && !value.startsWith('#')) el.removeAttribute(attr.name)
    else if (/(?:java|vb)script:|data:text\/html/i.test(value)) el.removeAttribute(attr.name)
  }
}

/**
 * Parse ``svg`` and return its cleaned root, ready to insert. Returns an
 * empty ``<svg>`` when the markup is not a single SVG document.
 */
export function sanitizeDiagramSvg(svg: string, doc: Document = document): Node {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (!root || root.localName !== 'svg' || parsed.getElementsByTagName('parsererror').length > 0) {
    return doc.createElementNS(SVG_NS, 'svg')
  }
  for (const el of [...root.getElementsByTagName('*')]) {
    const name = el.localName.toLowerCase()
    if (BLOCKED_ELEMENTS.has(name)) {
      el.remove()
      continue
    }
    if (name === 'a') {
      // Links are off when rendering; keep the content, drop the anchor.
      el.replaceWith(...el.childNodes)
      continue
    }
    cleanElement(el)
  }
  cleanElement(root)
  return doc.importNode(root, true)
}

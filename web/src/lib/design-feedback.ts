/**
 * Design feedback from the Preview tab, carried inside a chat message.
 *
 * The composer holds feedback as a chip; on send it is written into the
 * message as a tagged block the agent reads directly:
 *
 *   <design-feedback page="http://localhost:5173/pricing" viewport="Mobile 390×844">
 *   1. <button.cta> "Start free"
 *      selector: main > section.pricing > button.cta
 *      source: @src/Pricing.tsx#L42-L71
 *      comment: Make this larger
 *   </design-feedback>
 *
 * The UI parses the block back out: the chat bubble shows it as a card, and
 * a message restored into the composer turns it back into a chip. ``@``
 * sources are registered as mentions, so the backend attaches those lines.
 */

export interface DesignFeedbackItem {
  /** Pin number on the page. */
  n: number
  /** ``<button.cta>`` */
  element: string
  /** The element's text, shortened. */
  text: string
  selector: string
  /** ``@src/App.tsx#L42-L71``, a path outside the workspace, ``component Hero``, or ``null``. */
  source: string | null
  /** Opening tag. */
  html: string
  /** ``font-size: 14px; color: …`` */
  styles: string
  /** Page path when the comments span pages, else ``null``. */
  page: string | null
  comment: string
}

export interface DesignFeedback {
  /** ``http://localhost:5173/pricing`` or ``@designs/landing.html``. */
  where: string
  /** ``Mobile 390×844`` */
  device: string
  items: DesignFeedbackItem[]
}

const TAG = 'design-feedback'
const BLOCK_RE = /<design-feedback\b([^>\n]*)>\n([\s\S]*?)\n?<\/design-feedback>/g
const FIELD_INDENT = '   '
const CONTINUATION_INDENT = '     '

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[\n\r]/g, ' ')
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/** Comments must not end the block early. */
const neutralize = (s: string) => s.replace(/<\/design-feedback/gi, '</design feedback')

export function serializeDesignFeedback(feedback: DesignFeedback): string {
  const lines = [`<${TAG} page="${escapeAttr(feedback.where)}" viewport="${escapeAttr(feedback.device)}">`]
  for (const item of feedback.items) {
    const text = oneLine(item.text)
    lines.push(`${item.n}. ${oneLine(item.element)}${text ? ` ${JSON.stringify(text)}` : ''}`)
    const field = (key: string, value: string | null) => {
      const v = value ? neutralize(oneLine(value)) : ''
      if (v) lines.push(`${FIELD_INDENT}${key}: ${v}`)
    }
    field('selector', item.selector)
    field('source', item.source)
    field('html', item.html)
    field('styles', item.styles)
    field('page', item.page)
    const comment = neutralize(item.comment.trim()).split('\n')
    lines.push(`${FIELD_INDENT}comment: ${comment[0] ?? ''}`)
    for (const rest of comment.slice(1)) lines.push(`${CONTINUATION_INDENT}${rest}`)
  }
  lines.push(`</${TAG}>`)
  return lines.join('\n')
}

const ITEM_RE = /^(\d+)\. (<[^>]*>)(?: (".*"))?$/
const FIELD_RE = /^ {3}(selector|source|html|styles|page|comment): ?(.*)$/

function parseBody(attrs: string, body: string): DesignFeedback | null {
  const attr = (name: string) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
    return m ? unescapeAttr(m[1]) : ''
  }
  const items: DesignFeedbackItem[] = []
  let current: DesignFeedbackItem | null = null
  let inComment = false
  for (const line of body.split('\n')) {
    const head = ITEM_RE.exec(line)
    if (head) {
      let text = ''
      if (head[3]) {
        try {
          text = String(JSON.parse(head[3]))
        } catch {
          text = head[3].slice(1, -1)
        }
      }
      current = { n: Number(head[1]), element: head[2], text, selector: '', source: null, html: '', styles: '', page: null, comment: '' }
      items.push(current)
      inComment = false
      continue
    }
    if (!current) continue
    if (inComment && line.startsWith(CONTINUATION_INDENT)) {
      current.comment += `\n${line.slice(CONTINUATION_INDENT.length)}`
      continue
    }
    const field = FIELD_RE.exec(line)
    if (!field) continue
    const [, key, value] = field
    inComment = key === 'comment'
    if (key === 'comment') current.comment = value
    else if (key === 'source' || key === 'page') current[key] = value || null
    else current[key as 'selector' | 'html' | 'styles'] = value
  }
  return items.length ? { where: attr('page'), device: attr('viewport'), items } : null
}

/** Pull every design feedback block out of ``message``. */
export function splitDesignFeedback(raw: string): { text: string; blocks: DesignFeedback[] } {
  if (!raw.includes(`<${TAG}`)) return { text: raw, blocks: [] }
  // Messages are posted as multipart form data, which turns every line
  // break into CRLF, so history returns blocks the LF-only parser would miss.
  const message = raw.replace(/\r\n?/g, '\n')
  const blocks: DesignFeedback[] = []
  const text = message.replace(BLOCK_RE, (whole, attrs: string, body: string) => {
    const parsed = parseBody(attrs, body)
    if (!parsed) return whole
    blocks.push(parsed)
    return ''
  })
  if (!blocks.length) return { text: raw, blocks }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), blocks }
}

/** The text a message is sent with: the typed text, then each block. */
export function composeWithDesignFeedback(text: string, blocks: readonly DesignFeedback[]): string {
  return [text.trim(), ...blocks.map(serializeDesignFeedback)].filter(Boolean).join('\n\n')
}

/** Workspace ``@`` references in the block, as composer mentions. */
export function designFeedbackMentions(feedback: DesignFeedback): string[] {
  const out = new Set<string>()
  if (feedback.where.startsWith('@')) out.add(feedback.where.slice(1))
  for (const item of feedback.items) if (item.source?.startsWith('@')) out.add(item.source.slice(1))
  return [...out]
}

/** ``Preview comments · 3 comments`` */
export function designFeedbackSummary(feedback: DesignFeedback): string {
  const n = feedback.items.length
  return `Preview comments · ${n} ${n === 1 ? 'comment' : 'comments'}`
}

/** ``message`` for plain-text surfaces: each block becomes a one-line summary. */
export function designFeedbackPlainText(message: string): string {
  const { text, blocks } = splitDesignFeedback(message)
  if (!blocks.length) return message
  const summaries = blocks.map((b) => `[${designFeedbackSummary(b)} on ${b.where.replace(/^https?:\/\//, '')}]`)
  return [text, ...summaries].filter(Boolean).join('\n')
}

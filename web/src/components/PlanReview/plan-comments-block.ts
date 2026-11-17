/**
 * Comments on the session plan, carried inside a chat message.
 *
 * The Plan tab's **Reply in chat** moves a review's comments into the
 * composer as one chip; on send they are written into the message as a
 * tagged block the agent reads directly, in the review's comment format:
 *
 *   <plan-comments path=".agents/plans/x.md" revision="3">
 *   **Comment 1**
 *   > the passage
 *
 *   what to change
 *   </plan-comments>
 *
 * The UI parses the block back out: the chat bubble shows it as a card, and
 * a message restored into the composer turns it back into the chip. A
 * message holds at most one block; comments added later merge into it.
 */
import { formatPlanReview, parsePlanReview } from './plan-comments'

export interface PlanCommentsBlock {
  /** The plan file as the agent names it (workspace-relative when it can be), else ``null``. */
  path: string | null
  /** The plan revision the comments are on, else ``null``. */
  revision: number | null
  comments: { quote: string; text: string }[]
}

/** What the Plan tab's Reply in chat hands the composer. */
export interface PlanCommentsHandoff {
  /** The review's comments, or ``null`` when there are none (Reply in chat only focuses the composer). */
  block: PlanCommentsBlock | null
  /** Feedback typed in the tab's former feedback box (a draft from before it went). */
  text?: string
}

const TAG = 'plan-comments'
const BLOCK_RE = /<plan-comments\b([^>\n]*)>\n([\s\S]*?)\n?<\/plan-comments>/g

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[\n\r]/g, ' ')
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/** Comments must not end the block early. */
const neutralize = (s: string) => s.replace(/<\/plan-comments/gi, '</plan comments')

export function serializePlanComments(block: PlanCommentsBlock): string {
  const attrs = [
    block.path ? ` path="${escapeAttr(block.path)}"` : '',
    block.revision != null ? ` revision="${block.revision}"` : '',
  ].join('')
  const comments = block.comments.map((comment) => ({ quote: neutralize(comment.quote), text: neutralize(comment.text) }))
  return `<${TAG}${attrs}>\n${formatPlanReview(comments, '')}\n</${TAG}>`
}

function parseBlock(attrs: string, body: string): PlanCommentsBlock | null {
  const attr = (name: string) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
    return m ? unescapeAttr(m[1]) : null
  }
  const { comments } = parsePlanReview(body)
  if (comments.length === 0) return null
  const revision = Number(attr('revision'))
  return { path: attr('path') || null, revision: Number.isInteger(revision) && revision > 0 ? revision : null, comments }
}

/** Pull the plan comments block out of ``raw``; several blocks merge into one. */
export function splitPlanComments(raw: string): { text: string; block: PlanCommentsBlock | null } {
  if (!raw.includes(`<${TAG}`)) return { text: raw, block: null }
  // Messages are posted as multipart form data, which turns every line
  // break into CRLF, so history returns blocks the LF-only parser would miss.
  const message = raw.replace(/\r\n?/g, '\n')
  const found: PlanCommentsBlock[] = []
  const text = message.replace(BLOCK_RE, (whole, attrs: string, body: string) => {
    const parsed = parseBlock(attrs, body)
    if (!parsed) return whole
    found.push(parsed)
    return ''
  })
  const block = found.reduce<PlanCommentsBlock | null>(mergePlanComments, null)
  if (!block) return { text: raw, block: null }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), block }
}

/** ``next`` added to ``prev``: its comments after the ones already there, its plan and revision winning. */
export function mergePlanComments(prev: PlanCommentsBlock | null, next: PlanCommentsBlock): PlanCommentsBlock {
  if (!prev) return next
  return {
    path: next.path ?? prev.path,
    revision: next.revision ?? prev.revision,
    comments: [...prev.comments, ...next.comments],
  }
}

/** The text a message is sent with: ``text`` (typed text and any other blocks), then the block. */
export function composeWithPlanComments(text: string, block: PlanCommentsBlock | null): string {
  return [text.trim(), block && block.comments.length > 0 ? serializePlanComments(block) : ''].filter(Boolean).join('\n\n')
}

/** ``Plan comments · 2 comments`` */
export function planCommentsSummary(block: PlanCommentsBlock): string {
  const n = block.comments.length
  return `Plan comments · ${n} ${n === 1 ? 'comment' : 'comments'}`
}

/** ``message`` for plain-text surfaces: the block becomes a one-line summary. */
export function planCommentsPlainText(message: string): string {
  const { text, block } = splitPlanComments(message)
  if (!block) return message
  const revision = block.revision != null ? ` on rev ${block.revision}` : ''
  return [text, `[${planCommentsSummary(block)}${revision}]`].filter(Boolean).join('\n')
}

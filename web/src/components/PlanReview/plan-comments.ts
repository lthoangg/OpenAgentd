/**
 * Comments on the session plan during a review.
 *
 * Selecting plan text in the Plan tab offers Comment; each comment keeps the
 * passage it is about, which stays highlighted in the plan. Request changes
 * sends every comment, plus any overall feedback, as one Markdown answer:
 *
 *     **Comment 1**
 *     > the passage
 *
 *     what to change
 *
 *     **Overall**
 *     anything else
 *
 * The Plan-mode prompt asks the agent to address comments on quoted parts of
 * the plan (`> …`). The transcript card parses the same text back to show the
 * comments rather than a flattened quote.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react'
import { createPersistedDraftMap } from '@/lib/persisted-drafts'

export interface PlanComment {
  id: string
  /** The selected plan text, as selected. */
  quote: string
  text: string
}

export interface ParsedPlanReview {
  comments: { quote: string; text: string }[]
  overall: string
}

/** Longest passage quoted back to the agent; it has the full plan. */
const QUOTE_MAX = 300
const COMMENT_HEADING = /^\*\*Comment \d+\*\*$/
const OVERALL_HEADING = '**Overall**'

function tidy(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** A passage as it is quoted: blank lines collapsed, long ones cut. */
export function quoteExcerpt(quote: string): string {
  const text = tidy(quote).replace(/\n{2,}/g, '\n')
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1).trimEnd()}…` : text
}

/** The review answer: numbered comments on quoted passages, then the rest. */
export function formatPlanReview(comments: readonly { quote: string; text: string }[], overall: string): string {
  const rest = tidy(overall)
  const parts = comments
    .filter((comment) => tidy(comment.text))
    .map((comment, index) => {
      const quote = quoteExcerpt(comment.quote).split('\n').map((line) => `> ${line}`).join('\n')
      return `**Comment ${index + 1}**\n${quote}\n\n${tidy(comment.text)}`
    })
  if (parts.length === 0) return rest
  if (rest) parts.push(`${OVERALL_HEADING}\n${rest}`)
  return parts.join('\n\n')
}

/**
 * The comments in a review answer. Also reads the earlier free-text form,
 * where each comment followed its `> passage` in one box.
 */
export function parsePlanReview(text: string): ParsedPlanReview {
  const lines = tidy(text).split('\n')
  const structured = lines.some((line) => COMMENT_HEADING.test(line.trim()))
  const comments: { quote: string[]; text: string[] }[] = []
  const overall: string[] = []
  let current: { quote: string[]; text: string[] } | null = null
  let inOverall = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (structured && COMMENT_HEADING.test(trimmed)) {
      current = { quote: [], text: [] }
      comments.push(current)
      inOverall = false
      continue
    }
    if (structured && trimmed === OVERALL_HEADING) {
      current = null
      inOverall = true
      continue
    }
    const quoteLine = trimmed.startsWith('>')
    if (!structured && quoteLine && (!current || current.text.some(Boolean))) {
      // Earlier form: a new quote run starts the next comment.
      current = { quote: [], text: [] }
      comments.push(current)
    }
    if (current && quoteLine && !current.text.some(Boolean)) {
      current.quote.push(trimmed.replace(/^>\s?/, ''))
      continue
    }
    if (current && !inOverall) current.text.push(line)
    else overall.push(line)
  }
  return {
    comments: comments
      .map((comment) => ({ quote: comment.quote.join('\n').trim(), text: comment.text.join('\n').trim() }))
      .filter((comment) => comment.quote || comment.text),
    overall: overall.join('\n').trim(),
  }
}

/** Plan overlays (the Comment button, the composer) are not plan text. */
export const PLAN_OVERLAY_ATTR = 'data-plan-overlay'

/**
 * The first place `quote` occurs in the text under `root`, ignoring
 * whitespace: a selection across blocks reads back with line breaks the text
 * nodes do not have. `null` when the plan no longer contains it.
 */
export function findTextRange(root: Node, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, '')
  if (!needle || typeof document === 'undefined') return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(`[${PLAN_OVERLAY_ATTR}]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  const chars: string[] = []
  const at: [Text, number][] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]
      if (ch === undefined || /\s/.test(ch)) continue
      chars.push(ch)
      at.push([node as Text, i])
    }
  }
  const start = chars.join('').indexOf(needle)
  if (start < 0) return null
  const first = at[start]
  const last = at[start + needle.length - 1]
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first[0], first[1])
  range.setEnd(last[0], last[1] + 1)
  return range
}

export interface PlanSelection {
  text: string
  /** Bottom edge and end of the selection's last line, relative to `body`. */
  top: number
  left: number
  /** `body`'s width, to keep overlays inside it. */
  width: number
}

/**
 * The text selected inside `body` and where it ends. Follows
 * `selectionchange`, so pointer drags, keyboard selection and touch selection
 * handles all update it.
 */
export function usePlanSelection(bodyRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [selection, setSelection] = useState<PlanSelection | null>(null)
  const update = useCallback(() => {
    const body = bodyRef.current
    const sel = window.getSelection()
    if (!body || !sel || sel.isCollapsed || sel.rangeCount === 0) return setSelection(null)
    const range = sel.getRangeAt(0)
    const text = sel.toString().trim()
    if (!text || !body.contains(range.commonAncestorContainer)) return setSelection(null)
    if (range.commonAncestorContainer.parentElement?.closest(`[${PLAN_OVERLAY_ATTR}]`)) return setSelection(null)
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0)
    const end = rects[rects.length - 1] ?? range.getBoundingClientRect()
    const box = body.getBoundingClientRect()
    const next = { text, top: Math.max(0, end.bottom - box.top), left: Math.max(0, end.right - box.left), width: box.width }
    setSelection((prev) =>
      prev && prev.text === next.text && prev.top === next.top && prev.left === next.left && prev.width === next.width ? prev : next,
    )
  }, [bodyRef])
  useEffect(() => {
    if (!enabled) return
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [enabled, update])
  return { selection: enabled ? selection : null, clear: () => setSelection(null) }
}

/** Where an overlay of `overlayWidth` sits under a selection, kept inside the body. */
export function overlayLeft(selection: PlanSelection, overlayWidth: number, margin = 8): number {
  const max = Math.max(margin, selection.width - overlayWidth - margin)
  return Math.min(Math.max(margin, selection.left - overlayWidth / 2), max)
}

export interface PlanReviewDraft {
  comments: PlanComment[]
  overall: string
}

/**
 * Review drafts by question id, so comments survive the Plan tab unmounting
 * (switching dock tabs, closing the mobile sheet) and a reload or crash.
 */
const MAX_DRAFTS = 20
const drafts = createPersistedDraftMap<PlanReviewDraft>({ storageKey: 'oa.drafts.planReview.v1', max: MAX_DRAFTS })

export function readPlanReviewDraft(questionId: string | null): PlanReviewDraft {
  return (questionId && drafts.get(questionId)) || { comments: [], overall: '' }
}

export function writePlanReviewDraft(questionId: string, draft: PlanReviewDraft): void {
  if (draft.comments.length === 0 && !draft.overall) {
    drafts.delete(questionId)
    return
  }
  drafts.set(questionId, draft)
}

export function forgetPlanReviewDraft(questionId: string): void {
  drafts.delete(questionId)
}

/** Test seam. */
export function clearPlanReviewDrafts(): void {
  drafts.clear()
}

/** CSS Custom Highlight names; styled in `index.css`. */
export const PLAN_COMMENT_HIGHLIGHT = 'plan-comment'
export const PLAN_COMMENT_ACTIVE_HIGHLIGHT = 'plan-comment-active'

export { highlightApi } from '@/utils/css-highlights'

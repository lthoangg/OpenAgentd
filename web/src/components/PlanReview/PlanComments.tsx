/**
 * The Plan tab's review comments: the Comment button on a selection, the
 * composer anchored under the passage, the list in the review footer, and the
 * highlights that keep each commented passage marked in the plan.
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { MessageSquarePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  PLAN_COMMENT_ACTIVE_HIGHLIGHT,
  PLAN_COMMENT_HIGHLIGHT,
  PLAN_OVERLAY_ATTR,
  findTextRange,
  highlightApi,
  overlayLeft,
  type PlanComment,
  type PlanSelection,
} from './plan-comments'

/** Longest single comment; the whole review must also fit the answer limit. */
export const PLAN_COMMENT_MAX_CHARS = 2000

const overlay = { [PLAN_OVERLAY_ATTR]: '' }
const COMMENT_BUTTON_WIDTH = 96
const COMPOSER_MAX_WIDTH = 320

/** Floating "Comment" button under the end of a plan selection. */
export function CommentButton({ selection, onComment }: { selection: PlanSelection; onComment: () => void }) {
  return (
    <Button
      {...overlay}
      type="button"
      variant="default"
      size="xs"
      // Keep the selection: a mousedown on the button would collapse it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onComment}
      className="shadow-(--shadow-depth) absolute z-10 gap-1"
      style={{ top: selection.top + 6, left: overlayLeft(selection, COMMENT_BUTTON_WIDTH) }}
      aria-label="Comment on selection"
    >
      <MessageSquarePlus size={11} aria-hidden="true" />
      Comment
    </Button>
  )
}

/** The comment being written, anchored under the passage it is about. */
export function CommentComposer({
  anchor,
  quote,
  text,
  onChange,
  onAdd,
  onCancel,
  scrollRef,
}: {
  anchor: PlanSelection
  quote: string
  text: string
  onChange: (text: string) => void
  onAdd: () => void
  onCancel: () => void
  /** The plan's scroll container, scrolled so the composer is in view. */
  scrollRef: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = Math.min(COMPOSER_MAX_WIDTH, Math.max(0, anchor.width - 16))

  // Scroll the plan, not its ancestors, so the whole composer is visible.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    const scroller = scrollRef.current
    if (!box || !scroller) return
    const view = scroller.getBoundingClientRect()
    const overflow = box.bottom + 8 - view.bottom
    if (overflow > 0) scroller.scrollTop += overflow
  }, [scrollRef])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && text.trim()) {
      event.preventDefault()
      onAdd()
    }
  }

  return (
    <div
      {...overlay}
      ref={ref}
      role="group"
      aria-label="New comment"
      className="shadow-(--shadow-depth) absolute z-20 rounded-sm border border-(--color-border) bg-(--bg-card) p-2"
      style={{ top: anchor.top + 6, left: overlayLeft(anchor, width), width }}
    >
      <p className="mb-1.5 line-clamp-2 border-l-2 border-(--color-border-strong) pl-2 text-[11px] leading-relaxed text-(--color-text-subtle)">
        {quote}
      </p>
      <Textarea
        autoFocus
        aria-label="Comment"
        placeholder="What should change here?"
        value={text}
        maxLength={PLAN_COMMENT_MAX_CHARS}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-40 min-h-16 text-xs"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="primary" size="xs" onClick={onAdd} disabled={!text.trim()}>
          Add comment
        </Button>
      </div>
    </div>
  )
}

/** The comments so far, in the review footer. */
export function CommentList({
  comments,
  onShow,
  onRemove,
}: {
  comments: readonly PlanComment[]
  onShow: (comment: PlanComment) => void
  onRemove: (comment: PlanComment) => void
}) {
  return (
    <ul aria-label="Comments on the plan" className="max-h-36 space-y-1 overflow-y-auto overscroll-contain">
      {comments.map((comment, index) => (
        <li
          key={comment.id}
          className="flex items-start gap-1 rounded-sm border border-(--color-border-subtle) bg-(--bg-input) py-1 pr-1 pl-2"
        >
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => onShow(comment)}
              title="Show in the plan"
              className="block w-full truncate border-l-2 border-(--color-border-strong) pl-1.5 text-left text-[11px] leading-relaxed text-(--color-text-subtle) hover:text-(--color-text-muted) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
            >
              {comment.quote}
            </button>
            <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-(--color-text)">
              {comment.text}
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove comment ${index + 1}`} onClick={() => onRemove(comment)}>
            <X size={11} aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Mark every commented passage in the plan. Recomputed when the rendered
 * plan changes (Markdown can re-render code blocks after the first paint).
 * Browsers without the CSS Custom Highlight API simply show no marks.
 */
export function useCommentHighlights(bodyRef: RefObject<HTMLElement | null>, quotes: readonly string[]) {
  const key = quotes.join('\u0000')
  useEffect(() => {
    const api = highlightApi()
    const body = bodyRef.current
    if (!api || !body) return
    const list = key ? key.split('\u0000') : []
    let frame = 0
    const paint = () => {
      frame = 0
      const ranges = list.map((quote) => findTextRange(body, quote)).filter((range): range is Range => range !== null)
      if (ranges.length) api.registry.set(PLAN_COMMENT_HIGHLIGHT, api.create(ranges))
      else api.registry.delete(PLAN_COMMENT_HIGHLIGHT)
    }
    paint()
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(paint)
    })
    observer.observe(body, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      api.registry.delete(PLAN_COMMENT_HIGHLIGHT)
    }
  }, [bodyRef, key])
}

/**
 * Scroll the plan to a commented passage and flash it. Returns false when the
 * plan no longer contains the passage.
 */
export function showPassage(body: HTMLElement | null, scroller: HTMLElement | null, quote: string, reducedMotion: boolean): boolean {
  const range = body ? findTextRange(body, quote) : null
  if (!range || !scroller) return false
  const rect = range.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  scroller.scrollTo({ top: scroller.scrollTop + rect.top - view.top - view.height / 3, behavior: reducedMotion ? 'auto' : 'smooth' })
  const api = highlightApi()
  if (api) {
    api.registry.set(PLAN_COMMENT_ACTIVE_HIGHLIGHT, api.create([range]))
    window.setTimeout(() => api.registry.delete(PLAN_COMMENT_ACTIVE_HIGHLIGHT), 1500)
  }
  return true
}

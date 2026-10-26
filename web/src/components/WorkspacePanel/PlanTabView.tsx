/**
 * PlanTabView — the session plan as a review-dock tab (full-screen sheet on
 * mobile).
 *
 * The lead writes the plan with the ``plan`` tool and submits it with the
 * same tool (``submit: true``); while that review is open the footer offers Approve and
 * Request changes. Selecting plan text offers Comment: each comment stays
 * anchored to its passage (highlighted in the plan, listed in the footer) and
 * Request changes sends them all, with any overall feedback, as one answer.
 * The user can also edit the plan here (or in any editor): the server notices
 * the change by content and tells the agent once.
 *
 * Links and file-named code spans that point into the workspace open in the
 * dock: an HTML attachment (a mockup) in the Preview tab, anything else as a
 * file tab. Images (SVG diagrams) render inline through the media route.
 *
 * Everything from the plan's ``## Appendix`` heading on (implementation
 * detail) sits collapsed under the body. It stays in the DOM, so selecting
 * text in it, comment highlights, and jumping to a comment all work; jumping
 * to a passage in a closed Appendix opens it first.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Copy, ExternalLink, FileText, MessageSquarePlus, Pencil, Unlink } from 'lucide-react'
import type { SessionPlan } from '@/api/types'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { useKeyboardOpen } from '@/hooks/use-keyboard-open'
import { dismissKeyboard } from '@/hooks/use-mobile-viewport'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries/keys'
import { useUpdateSessionPlanMutation } from '@/queries/useUpdateSessionPlanMutation'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import { formatCompactRelative, formatRelativeDate } from '@/utils/format'
import { workspaceRelativePath } from '@/utils/file-refs'
import { MarkdownBlock } from '@/utils/markdown'
import { useQuestionResolver } from '../AskUser/useQuestionResolver'
import { FileRefContext, type FileRefOpener } from '../FileRefLink'
import { CommentButton, CommentComposer, CommentList, showPassage, useCommentHighlights } from '../PlanReview/PlanComments'
import { readAppendixOpen, splitPlanAppendix, writeAppendixOpen } from '../PlanReview/plan-appendix'
import {
  findTextRange,
  forgetPlanReviewDraft,
  formatPlanReview,
  passageAnchor,
  readPlanReviewDraft,
  usePlanSelection,
  writePlanReviewDraft,
  type PlanReviewDraft,
  type PlanSelection,
} from '../PlanReview/plan-comments'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

/** Mirrors the server's limits (``PLAN_MAX_CHARS``, ``PLAN_REVIEW_MAX_ANSWER_CHARS``). */
export const PLAN_MAX_CHARS = 100_000
export const PLAN_FEEDBACK_MAX_CHARS = 8000

const APPROVE = 'Approve'
const REQUEST_CHANGES = 'Request changes'

export type PlanStatus = 'review' | 'approved' | 'changed' | 'draft'

export function planStatus(plan: SessionPlan, reviewing: boolean): PlanStatus {
  if (reviewing) return 'review'
  const approved = plan.approved_revision
  if (approved === null || approved === undefined) return 'draft'
  return plan.revision !== undefined && plan.revision > approved ? 'changed' : 'approved'
}

const STATUS_CHIP: Record<PlanStatus, { label: string; className: string }> = {
  review: { label: 'Awaiting review', className: 'bg-(--color-warning-subtle) text-(--accent-orange-text)' },
  approved: { label: 'Approved', className: 'bg-(--color-success-subtle) text-(--accent-green-text)' },
  changed: { label: 'Changed since approval', className: 'bg-(--bg-key) text-(--color-text-muted)' },
  draft: { label: 'Draft', className: 'bg-(--bg-key) text-(--color-text-muted)' },
}

const HTML_FILE = /\.html?$/i

/**
 * How long a touch selection is remembered after iOS collapses it, so a tap
 * on "Comment on selection" still sees it (the tap itself can clear the
 * selection before the click lands).
 */
const SELECTION_HOLD_MS = 400

interface ComposerState {
  quote: string
  /** Where the passage ends; null for a draft restored before the plan laid out. */
  anchor: PlanSelection | null
  text: string
}

function restoredComposer(draft: PlanReviewDraft): ComposerState | null {
  return draft.composer ? { quote: draft.composer.quote, anchor: null, text: draft.composer.text } : null
}

function isConflict(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { status?: unknown }).status === 409
}

function ToolbarAction({
  label,
  tooltip,
  onClick,
  disabled,
  children,
}: {
  label: string
  tooltip?: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" onClick={onClick} disabled={disabled} className={DOCK_ACTION_BUTTON_CLASS} aria-label={label}>
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{tooltip ?? label}</TooltipContent>
    </Tooltip>
  )
}

export interface PlanTabViewProps {
  plan: SessionPlan | null
  sessionId: string | null
  /** Stop using the plan in this session (a workspace file stays). */
  onClearPlan?: () => void
  /** Open a workspace-relative path as a file tab. */
  onOpenFile?: (path: string) => void
  /** Open a workspace-relative HTML file in a Preview tab. */
  onOpenPreview?: (path: string) => void
  /** The workspace root, for links written as absolute paths. */
  workspace?: string | null
}

/** How plan links open workspace files: HTML in Preview, the rest as file tabs. */
export function planFileOpener(
  workspace: string | null,
  onOpenFile?: (path: string) => void,
  onOpenPreview?: (path: string) => void,
): FileRefOpener | null {
  if (!onOpenFile && !onOpenPreview) return null
  const target = (path: string) => {
    const rel = workspaceRelativePath(path, workspace)
    if (!rel) return null
    if (HTML_FILE.test(rel) && onOpenPreview) return () => onOpenPreview(rel)
    return onOpenFile ? () => onOpenFile(rel) : null
  }
  return {
    canOpen: (ref) => target(ref.path) !== null,
    open: (ref) => target(ref.path)?.(),
  }
}

export function PlanTabView({ plan, sessionId, onClearPlan, onOpenFile, onOpenPreview, workspace = null }: PlanTabViewProps) {
  const pendingQuestion = useAgentStore((s) => s.pendingQuestion)
  const review = pendingQuestion?.kind === 'plan_review' ? pendingQuestion : null
  const reviewId = review?.id ?? null
  const resolver = useQuestionResolver(review)
  const queryClient = useQueryClient()
  const update = useUpdateSessionPlanMutation()
  const reducedMotion = useReducedMotion() ?? false
  // Mobile reviews dock the Comment action and the composer in the footer,
  // where they sit on the soft keyboard; the footer compacts while it is up.
  const mobile = useIsMobile()
  const keyboardOpen = useKeyboardOpen()
  const commentIdPrefix = useId()
  const fileOpener = useMemo(() => planFileOpener(workspace, onOpenFile, onOpenPreview), [workspace, onOpenFile, onOpenPreview])

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // The revision the editor opened; a newer one on the server is a conflict
  // until the user reopens the editor on it.
  const [baseRevision, setBaseRevision] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Comments and overall feedback belong to one review; they survive the tab
  // unmounting (see ``readPlanReviewDraft``) and a new review starts empty.
  const [reviewDraft, setReviewDraft] = useState<PlanReviewDraft>(() => readPlanReviewDraft(reviewId))
  // So does a half-written comment.
  const [composer, setComposer] = useState<ComposerState | null>(() => restoredComposer(readPlanReviewDraft(reviewId)))
  const [draftFor, setDraftFor] = useState(reviewId)
  if (reviewId !== draftFor) {
    setDraftFor(reviewId)
    const next = readPlanReviewDraft(reviewId)
    setReviewDraft(next)
    setComposer(restoredComposer(next))
  }
  const previousReview = useRef(reviewId)
  useEffect(() => {
    const previous = previousReview.current
    if (previous && previous !== reviewId) forgetPlanReviewDraft(previous)
    previousReview.current = reviewId
  }, [reviewId])
  const persist = (draft: PlanReviewDraft, open: ComposerState | null) => {
    if (!reviewId) return
    writePlanReviewDraft(reviewId, {
      comments: draft.comments,
      overall: draft.overall,
      composer: open ? { quote: open.quote, text: open.text } : null,
    })
  }
  const changeDraft = (next: PlanReviewDraft) => {
    setReviewDraft(next)
    persist(next, composer)
  }
  const changeComposer = (next: ComposerState | null) => {
    setComposer(next)
    persist(reviewDraft, next)
  }

  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const commentInputRef = useRef<HTMLTextAreaElement>(null)
  const { selection, clear: clearSelection } = usePlanSelection(bodyRef, Boolean(review) && !editing && !composer)
  useCommentHighlights(bodyRef, editing ? [] : [...reviewDraft.comments.map((c) => c.quote), ...(composer ? [composer.quote] : [])])

  // Touch: hold the last selection briefly after it collapses, so the footer's
  // Comment action survives the tap that iOS may use to clear the selection.
  const [heldSelection, setHeldSelection] = useState<PlanSelection | null>(null)
  const pressingComment = useRef(false)
  useEffect(() => {
    if (!mobile) return
    if (selection) {
      setHeldSelection(selection)
      return
    }
    if (pressingComment.current) return
    const timer = window.setTimeout(() => setHeldSelection(null), SELECTION_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [mobile, selection])

  // A comment restored from a draft has no anchor yet: find its passage once
  // the plan has laid out (desktop floats the composer under it).
  useLayoutEffect(() => {
    if (!composer || composer.anchor || mobile || !bodyRef.current) return
    const anchor = passageAnchor(bodyRef.current, composer.quote)
    if (anchor) setComposer({ ...composer, anchor })
  }, [composer, mobile])

  // Mobile: keep the passage being commented on in view above the docked
  // composer, again once the keyboard has resized the plan.
  const composerQuote = composer?.quote ?? null
  useEffect(() => {
    if (!mobile || !composerQuote) return
    const frame = requestAnimationFrame(() => {
      showPassage(bodyRef.current, scrollRef.current, composerQuote, true)
    })
    return () => cancelAnimationFrame(frame)
  }, [mobile, composerQuote, keyboardOpen])

  // While typing on a phone, saved comments fold into a chip.
  const [showComments, setShowComments] = useState(false)
  const compactFooter = mobile && keyboardOpen
  useEffect(() => {
    if (!compactFooter) setShowComments(false)
  }, [compactFooter])

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const content = plan?.content ?? ''
  const parts = useMemo(() => splitPlanAppendix(content), [content])

  const appendixId = useId()
  const appendixRef = useRef<HTMLElement>(null)
  const [appendixFor, setAppendixFor] = useState(sessionId)
  const [appendixOpen, setAppendixOpen] = useState(() => readAppendixOpen(sessionId))
  if (appendixFor !== sessionId) {
    setAppendixFor(sessionId)
    setAppendixOpen(readAppendixOpen(sessionId))
  }
  const toggleAppendix = (open: boolean) => {
    setAppendixOpen(open)
    writeAppendixOpen(sessionId, open)
  }
  // A comment on Appendix text: open the Appendix, then scroll once it shows.
  const [pendingQuote, setPendingQuote] = useState<string | null>(null)
  useEffect(() => {
    if (!pendingQuote || !appendixOpen) return
    const frame = requestAnimationFrame(() => {
      showPassage(bodyRef.current, scrollRef.current, pendingQuote, reducedMotion)
      setPendingQuote(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingQuote, appendixOpen, reducedMotion])
  const showComment = (quote: string) => {
    if (!appendixOpen && appendixRef.current && findTextRange(appendixRef.current, quote)) {
      toggleAppendix(true)
      setPendingQuote(quote)
      return
    }
    showPassage(bodyRef.current, scrollRef.current, quote, reducedMotion)
  }

  if (!plan) {
    return (
      <EmptyState
        icon={FileText}
        title="No plan yet"
        body="In Plan mode the agent writes its plan here for you to review."
      />
    )
  }

  const status = planStatus(plan, Boolean(review))
  const chip = STATUS_CHIP[status]
  // A server without plan revisions (v2) has no edit route.
  const canEdit = plan.revision !== undefined && Boolean(sessionId)
  const unsavedEdits = editing && draft !== plan.content
  const { comments, overall } = reviewDraft
  const pendingComment = composer?.text.trim() ? [{ quote: composer.quote, text: composer.text }] : []
  const answerText = formatPlanReview([...comments, ...pendingComment], overall)
  const tooLong = answerText.length > PLAN_FEEDBACK_MAX_CHARS
  const approveHint = unsavedEdits
    ? 'Save or cancel your edits first'
    : pendingComment.length
      ? 'Add or cancel your comment first'
      : comments.length || overall.trim()
        ? 'Your comments go with Request changes'
        : null
  const footerHint = tooLong ? 'Too long to send — shorten your comments' : approveHint

  const startEditing = () => {
    setDraft(plan.content)
    setBaseRevision(plan.revision ?? 0)
    setSaveError(null)
    setEditing(true)
  }

  const save = () => {
    if (!sessionId) return
    setSaveError(null)
    update.mutate(
      { sessionId, content: draft, baseRevision },
      {
        onSuccess: () => setEditing(false),
        onError: (cause) => {
          if (isConflict(cause)) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.plan(sessionId) })
            useToastStore.getState().push({
              tone: 'error',
              title: 'The plan changed while you were editing',
              description: 'Copy your edits, then reopen the editor.',
            })
            return
          }
          setSaveError(cause instanceof Error && cause.message ? cause.message : 'Could not save the plan.')
        },
      },
    )
  }

  const startComment = (from: PlanSelection | null = selection) => {
    if (!from) return
    const next = { quote: from.text, anchor: from, text: '' }
    window.getSelection()?.removeAllRanges()
    clearSelection()
    setHeldSelection(null)
    if (mobile) {
      // Render the docked composer and focus it inside this tap: iOS raises
      // the keyboard only for focus that happens within a user gesture.
      // Focus last: WebKit keeps the box's caret in the page selection, so
      // clearing the selection after focusing would drop focus again.
      flushSync(() => changeComposer(next))
      commentInputRef.current?.focus()
    } else {
      changeComposer(next)
    }
  }

  const clearMobileSelection = () => {
    window.getSelection()?.removeAllRanges()
    clearSelection()
    setHeldSelection(null)
  }

  const addComment = () => {
    if (!composer?.text.trim()) return
    const id = `${commentIdPrefix}${Date.now().toString(36)}${comments.length}`
    const next = { ...reviewDraft, comments: [...comments, { id, quote: composer.quote, text: composer.text.trim() }] }
    setReviewDraft(next)
    setComposer(null)
    persist(next, null)
  }

  const requestChanges = () => {
    if (composer) addComment()
    if (mobile) dismissKeyboard()
    resolver.answer([[answerText || REQUEST_CHANGES]])
  }

  const copy = () => {
    void navigator.clipboard?.writeText(content).then(() => setCopied(true), () => {})
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) pl-3 pr-1.5">
        <span className="text-xs font-medium text-(--color-text)">Plan</span>
        <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium', chip.className)}>
          {chip.label}
        </span>
        {plan.revision !== undefined && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle)">rev {plan.revision}</span>
        )}
        <span
          className="hidden shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle) sm:inline"
          title={`Updated ${formatRelativeDate(plan.updated_at)}`}
        >
          {formatCompactRelative(plan.updated_at)}
        </span>
        <span className="min-w-0 flex-1" aria-hidden="true" />
        {canEdit && !editing && (
          <ToolbarAction label="Edit plan" onClick={startEditing}>
            <Pencil size={12} aria-hidden="true" />
          </ToolbarAction>
        )}
        {plan.workspace_path && onOpenFile && (
          <ToolbarAction label="Open file" tooltip={plan.workspace_path} onClick={() => onOpenFile(plan.workspace_path as string)}>
            <ExternalLink size={12} aria-hidden="true" />
          </ToolbarAction>
        )}
        <ToolbarAction label={copied ? 'Copied' : 'Copy plan'} onClick={copy}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        </ToolbarAction>
        {onClearPlan && (
          <ToolbarAction
            label="Clear plan"
            tooltip={review ? 'The plan is awaiting review.' : 'Stops using this plan in the session; the file stays.'}
            onClick={onClearPlan}
            disabled={Boolean(review)}
          >
            <Unlink size={12} aria-hidden="true" />
          </ToolbarAction>
        )}
      </div>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <Textarea
            aria-label="Plan Markdown"
            value={draft}
            maxLength={PLAN_MAX_CHARS}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none font-mono field-sizing-fixed"
          />
          {saveError && (
            <p role="alert" className="text-[11px] text-(--color-error)">{saveError}</p>
          )}
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={save} disabled={update.isPending || !draft.trim()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
          {/* `oa-reading` (index.css): a maximized dock widens tables, code
              and diagrams while prose keeps its measure. */}
          <div ref={bodyRef} className="oa-reading relative mx-auto max-w-3xl px-4 py-3">
            <FileRefContext.Provider value={fileOpener}>
              <MarkdownBlock content={parts.body} sessionId={sessionId ?? undefined} />
              {parts.appendix !== null && (
                <div className="oa-reading-measure mt-5 border-t border-(--color-border-subtle) pt-2 text-sm">
                  <button
                    type="button"
                    aria-expanded={appendixOpen}
                    aria-controls={appendixId}
                    onClick={() => toggleAppendix(!appendixOpen)}
                    title={parts.sections.length ? parts.sections.join(' · ') : undefined}
                    className="flex w-full min-w-0 items-center gap-1.5 rounded-sm py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
                  >
                    <ChevronRight
                      size={12}
                      aria-hidden="true"
                      className={cn('shrink-0 text-(--color-text-muted) motion-safe:transition-transform', appendixOpen && 'rotate-90')}
                    />
                    <span className="shrink-0 font-medium text-(--color-text)">{parts.title}</span>
                    {parts.sections.length > 0 && (
                      <span className="min-w-0 truncate text-(--color-text-subtle)">
                        · {parts.sections.length} {parts.sections.length === 1 ? 'section' : 'sections'}
                        {!appendixOpen && <span className="hidden sm:inline">: {parts.sections.join(', ')}</span>}
                      </span>
                    )}
                  </button>
                  <section id={appendixId} ref={appendixRef} hidden={!appendixOpen} aria-label={parts.title} className="pt-1">
                    <MarkdownBlock content={parts.appendix} sessionId={sessionId ?? undefined} />
                  </section>
                </div>
              )}
            </FileRefContext.Provider>
            {selection && review && !composer && !mobile && <CommentButton selection={selection} onComment={() => startComment()} />}
            {composer && review && !mobile && (
              <CommentComposer
                anchor={composer.anchor}
                quote={composer.quote}
                text={composer.text}
                onChange={(text) => changeComposer({ ...composer, text })}
                onAdd={addComment}
                onCancel={() => changeComposer(null)}
                scrollRef={scrollRef}
              />
            )}
          </div>
        </div>
      )}

      {review && mobile && composer ? (
        // Mobile: the comment being written docks here, on the keyboard.
        <div className="shrink-0 border-t border-(--color-border-subtle) bg-(--bg-card) px-3 pt-2.5 pb-safe">
          <div className="pb-2.5">
            <CommentComposer
              docked
              anchor={null}
              quote={composer.quote}
              text={composer.text}
              onChange={(text) => changeComposer({ ...composer, text })}
              onAdd={addComment}
              onCancel={() => changeComposer(null)}
              scrollRef={scrollRef}
              textareaRef={commentInputRef}
            />
          </div>
        </div>
      ) : review && mobile && !editing && heldSelection ? (
        // Mobile: selected plan text offers Comment here, clear of the
        // selection handles and the system menu iOS draws over the text.
        <div className="flex shrink-0 items-center gap-2 border-t border-(--color-border-subtle) bg-(--bg-card) px-3 pt-2.5 pb-safe">
          <div className="flex w-full items-center gap-2 pb-2.5">
            <Button type="button" variant="ghost" size="sm" onClick={clearMobileSelection}>
              Clear
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="flex-1 gap-1.5"
              // Keep the selection and the hold alive through the tap.
              onPointerDown={(event) => {
                event.preventDefault()
                pressingComment.current = true
              }}
              onPointerCancel={() => { pressingComment.current = false }}
              onClick={() => {
                pressingComment.current = false
                startComment(heldSelection)
              }}
              aria-label="Comment on selection"
            >
              <MessageSquarePlus size={12} aria-hidden="true" />
              Comment on selection
            </Button>
          </div>
        </div>
      ) : review && (
        <div className="shrink-0 space-y-2 border-t border-(--color-border-subtle) bg-(--bg-card) px-3 pt-2.5 pb-safe">
          {comments.length > 0 && (!compactFooter || showComments) && (
            <CommentList
              comments={comments}
              onShow={(comment) => showComment(comment.quote)}
              onRemove={(comment) => changeDraft({ ...reviewDraft, comments: comments.filter((c) => c.id !== comment.id) })}
            />
          )}
          <Textarea
            aria-label="Feedback on the plan"
            placeholder={comments.length ? 'Anything else? (optional)' : 'What should change? Select plan text to comment on it.'}
            value={overall}
            maxLength={PLAN_FEEDBACK_MAX_CHARS}
            onChange={(event) => changeDraft({ ...reviewDraft, overall: event.target.value })}
            className={cn(
              // While typing on a phone, cap the box to a share of the visible
              // area so the plan above stays readable.
              compactFooter ? 'max-h-[calc(var(--app-vh,100svh)*0.25)] min-h-10' : 'max-h-40',
              !compactFooter && (comments.length ? 'min-h-10' : 'min-h-16'),
            )}
          />
          {!compactFooter && <p className="text-[11px] text-(--color-text-subtle)">Or reply in chat to redirect the agent.</p>}
          {resolver.error && (
            <p role="alert" className="text-[11px] text-(--color-error)">{resolver.error}</p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pb-2.5">
            {compactFooter && comments.length > 0 ? (
              <button
                type="button"
                aria-expanded={showComments}
                // Keep focus (and the keyboard) in the feedback box.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setShowComments((open) => !open)}
                className="mr-auto inline-flex items-center gap-1 rounded-full border border-(--color-border) px-2 py-0.5 text-[11px] text-(--color-text-2)"
              >
                {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
                <ChevronRight
                  size={11}
                  aria-hidden="true"
                  className={cn('motion-safe:transition-transform', showComments ? '-rotate-90' : 'rotate-90')}
                />
              </button>
            ) : (
              footerHint && (!compactFooter || tooLong) && (
                <span className="mr-auto text-[11px] text-(--color-text-subtle)">{footerHint}</span>
              )
            )}
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={resolver.submitting || tooLong}
              onClick={requestChanges}
            >
              {comments.length + pendingComment.length > 0
                ? `Request changes (${comments.length + pendingComment.length})`
                : 'Request changes'}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={resolver.submitting || approveHint !== null}
              onClick={() => {
                if (mobile) dismissKeyboard()
                resolver.answer([[APPROVE]])
              }}
            >
              Approve
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

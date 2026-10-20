/**
 * PlanTabView — the session plan as a review-dock tab (full-screen sheet on
 * mobile).
 *
 * The lead writes the plan with the ``plan`` tool and submits it with
 * ``submit_plan``; while that review is open the footer offers Approve and
 * Request changes. Selecting plan text offers Comment: each comment stays
 * anchored to its passage (highlighted in the plan, listed in the footer) and
 * Request changes sends them all, with any overall feedback, as one answer.
 * The user can also edit the plan here (or in any editor): the server notices
 * the change by content and tells the agent once.
 *
 * While the lead's ``plan`` call streams, the tab shows the plan being written
 * in place (see ``useLivePlan``) and holds Edit and Clear until it lands.
 */
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, FileText, Pencil, Unlink } from 'lucide-react'
import type { SessionPlan } from '@/api/types'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries/keys'
import { useUpdateSessionPlanMutation } from '@/queries/useUpdateSessionPlanMutation'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import { formatCompactRelative, formatRelativeDate } from '@/utils/format'
import { MarkdownBlock } from '@/utils/markdown'
import { useQuestionResolver } from '../AskUser/useQuestionResolver'
import { useLivePlan } from '../PlanReview/live-plan'
import { CommentButton, CommentComposer, CommentList, showPassage, useCommentHighlights } from '../PlanReview/PlanComments'
import {
  forgetPlanReviewDraft,
  formatPlanReview,
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

const WRITING_CHIP_CLASS = 'bg-(--bg-key) text-(--color-marker-orange) motion-safe:animate-pulse'

/** How close to the bottom still counts as following the plan being written. */
const FOLLOW_SLACK_PX = 32

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
}

export function PlanTabView({ plan, sessionId, onClearPlan, onOpenFile }: PlanTabViewProps) {
  const pendingQuestion = useAgentStore((s) => s.pendingQuestion)
  const review = pendingQuestion?.kind === 'plan_review' ? pendingQuestion : null
  const reviewId = review?.id ?? null
  const resolver = useQuestionResolver(review)
  const queryClient = useQueryClient()
  const update = useUpdateSessionPlanMutation()
  const reducedMotion = useReducedMotion() ?? false
  const commentIdPrefix = useId()
  const live = useLivePlan(plan, sessionId)
  const writing = Boolean(live?.writing)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // The revision the editor opened; a newer one on the server is a conflict
  // until the user reopens the editor on it.
  const [baseRevision, setBaseRevision] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Comments and overall feedback belong to one review; they survive the tab
  // unmounting (see ``readPlanReviewDraft``) and a new review starts empty.
  const [reviewDraft, setReviewDraft] = useState<PlanReviewDraft>(() => readPlanReviewDraft(reviewId))
  const [composer, setComposer] = useState<{ quote: string; anchor: PlanSelection; text: string } | null>(null)
  const [draftFor, setDraftFor] = useState(reviewId)
  if (reviewId !== draftFor) {
    setDraftFor(reviewId)
    setReviewDraft(readPlanReviewDraft(reviewId))
    setComposer(null)
  }
  const previousReview = useRef(reviewId)
  useEffect(() => {
    const previous = previousReview.current
    if (previous && previous !== reviewId) forgetPlanReviewDraft(previous)
    previousReview.current = reviewId
  }, [reviewId])
  const changeDraft = (next: PlanReviewDraft) => {
    setReviewDraft(next)
    if (reviewId) writePlanReviewDraft(reviewId, next)
  }

  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { selection, clear: clearSelection } = usePlanSelection(bodyRef, Boolean(review) && !editing && !composer)
  useCommentHighlights(bodyRef, editing ? [] : [...reviewDraft.comments.map((c) => c.quote), ...(composer ? [composer.quote] : [])])

  // A write grows at the bottom: keep it in view unless the user scrolled up.
  const followRef = useRef(true)
  const following = writing && live?.action === 'write'
  useEffect(() => {
    const scroller = scrollRef.current
    const body = bodyRef.current
    if (!following || !scroller || !body || typeof ResizeObserver === 'undefined') return
    followRef.current = true
    const observer = new ResizeObserver(() => {
      if (followRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(body)
    return () => observer.disconnect()
  }, [following])
  const trackFollow = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
  }

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const content = live?.content ?? plan?.content ?? null
  // An edit rewrites the middle of the plan, so each chunk re-renders all
  // that follows; deferring lets that work yield to scrolling and typing.
  const renderedContent = useDeferredValue(content ?? '')
  if (content === null) {
    return (
      <EmptyState
        icon={FileText}
        title={writing ? 'Writing the plan…' : 'No plan yet'}
        body={writing ? 'It appears here as the agent writes it.' : 'In Plan mode the agent writes its plan here for you to review.'}
      />
    )
  }

  const chip = writing
    ? { label: live?.action === 'edit' ? 'Editing…' : 'Writing…', className: WRITING_CHIP_CLASS }
    : plan
      ? STATUS_CHIP[planStatus(plan, Boolean(review))]
      : STATUS_CHIP.draft
  // A server without plan revisions (v2) has no edit route.
  const canEdit = !live && plan?.revision !== undefined && Boolean(sessionId)
  const unsavedEdits = editing && draft !== plan?.content
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
    if (!plan) return
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

  const startComment = () => {
    if (!selection) return
    setComposer({ quote: selection.text, anchor: selection, text: '' })
    window.getSelection()?.removeAllRanges()
    clearSelection()
  }

  const addComment = () => {
    if (!composer?.text.trim()) return
    const id = `${commentIdPrefix}${Date.now().toString(36)}${comments.length}`
    changeDraft({ ...reviewDraft, comments: [...comments, { id, quote: composer.quote, text: composer.text.trim() }] })
    setComposer(null)
  }

  const requestChanges = () => {
    if (composer) addComment()
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
        {plan?.revision !== undefined && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle)">rev {plan.revision}</span>
        )}
        {plan && (
          <span
            className="hidden shrink-0 font-mono text-[11px] tabular-nums text-(--color-text-subtle) sm:inline"
            title={`Updated ${formatRelativeDate(plan.updated_at)}`}
          >
            {formatCompactRelative(plan.updated_at)}
          </span>
        )}
        <span className="min-w-0 flex-1" aria-hidden="true" />
        {canEdit && !editing && (
          <ToolbarAction label="Edit plan" onClick={startEditing}>
            <Pencil size={12} aria-hidden="true" />
          </ToolbarAction>
        )}
        {plan?.workspace_path && onOpenFile && (
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
            tooltip={
              review
                ? 'The plan is awaiting review.'
                : live
                  ? 'The agent is writing the plan.'
                  : 'Stops using this plan in the session; the file stays.'
            }
            onClick={onClearPlan}
            disabled={Boolean(review) || Boolean(live) || !plan}
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
        <div ref={scrollRef} onScroll={trackFollow} className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
          <div ref={bodyRef} className="relative mx-auto max-w-3xl px-4 py-3">
            <MarkdownBlock content={renderedContent} sessionId={sessionId ?? undefined} isStreaming={writing} />
            {selection && review && !composer && <CommentButton selection={selection} onComment={startComment} />}
            {composer && review && (
              <CommentComposer
                anchor={composer.anchor}
                quote={composer.quote}
                text={composer.text}
                onChange={(text) => setComposer({ ...composer, text })}
                onAdd={addComment}
                onCancel={() => setComposer(null)}
                scrollRef={scrollRef}
              />
            )}
          </div>
        </div>
      )}

      {review && (
        <div className="shrink-0 space-y-2 border-t border-(--color-border-subtle) bg-(--bg-card) px-3 pt-2.5 pb-safe">
          {comments.length > 0 && (
            <CommentList
              comments={comments}
              onShow={(comment) => showPassage(bodyRef.current, scrollRef.current, comment.quote, reducedMotion)}
              onRemove={(comment) => changeDraft({ ...reviewDraft, comments: comments.filter((c) => c.id !== comment.id) })}
            />
          )}
          <Textarea
            aria-label="Feedback on the plan"
            placeholder={comments.length ? 'Anything else? (optional)' : 'What should change? Select plan text to comment on it.'}
            value={overall}
            maxLength={PLAN_FEEDBACK_MAX_CHARS}
            onChange={(event) => changeDraft({ ...reviewDraft, overall: event.target.value })}
            className={cn('max-h-40', comments.length ? 'min-h-10' : 'min-h-16')}
          />
          <p className="text-[11px] text-(--color-text-subtle)">Or reply in chat to redirect the agent.</p>
          {resolver.error && (
            <p role="alert" className="text-[11px] text-(--color-error)">{resolver.error}</p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pb-2.5">
            {footerHint && <span className="mr-auto text-[11px] text-(--color-text-subtle)">{footerHint}</span>}
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
              onClick={() => resolver.answer([[APPROVE]])}
            >
              Approve
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

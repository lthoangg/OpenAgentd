/**
 * The ``submit_plan`` tool card, rendered inline in the transcript.
 *
 * The review itself happens in the Plan tab (the dock, or the full-screen
 * sheet on mobile); this card marks where the agent submitted the plan, says
 * how the review ended, and opens the plan.
 *
 * The outcome comes from the store while this client saw the review close,
 * and otherwise from the persisted tool result, which is all a cold load has.
 * The result sentences mirror ``plan::review_result_text``, the question
 * closing texts in ``queries/questions.rs``, and the agent loop's
 * ``SUBMIT_DEFERRED`` / ``SUBMIT_MERGED``.
 */
import { FileText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/useAgentStore'
import type { AgentStoreState, ResolvedQuestion } from '@/stores/useAgentStore'
import { parsePlanReview } from './plan-comments'

/** Mirrors the pending-question placeholder the server writes as the result. */
const PLACEHOLDER_PREFIX = 'Waiting for the user to answer'
const EDITED_PREFIX = 'The user edited the plan during review'
const APPROVE = 'Approve'
const REQUEST_CHANGES = 'Request changes'
/** Comments shown on the card; the rest are counted. */
const SHOWN_COMMENTS = 3

export type PlanReviewState =
  | { kind: 'submitting' }
  | { kind: 'waiting' }
  | { kind: 'approved' }
  | { kind: 'changes'; feedback: string | null }
  | { kind: 'closed'; reason: string | null }
  | { kind: 'not_submitted' }
  | { kind: 'merged' }
  | { kind: 'failed'; message: string | null }

const CLOSED_PREFIXES: readonly (readonly [string, PlanReviewState])[] = [
  ['Superseded', { kind: 'closed', reason: 'superseded' }],
  ['Question(s) being dismissed', { kind: 'closed', reason: 'dismissed' }],
  ['This question is no longer relevant', { kind: 'closed', reason: 'expired' }],
  ['Not submitted:', { kind: 'not_submitted' }],
  ['Merged into your other submit_plan call', { kind: 'merged' }],
  ['The plan could not be submitted', { kind: 'failed', message: null }],
  ['Tool execution was interrupted', { kind: 'failed', message: null }],
]

const CLOSED_LABEL: Record<string, string> = {
  superseded: 'Superseded by your next message',
  dismissed: 'Dismissed',
  expired: 'No longer relevant',
  resolved_elsewhere: 'Already resolved from another window or device',
}

function fromAnswer(answer: string): PlanReviewState {
  const text = answer.trim()
  if (text === APPROVE) return { kind: 'approved' }
  if (!text || text === REQUEST_CHANGES) return { kind: 'changes', feedback: null }
  return { kind: 'changes', feedback: text }
}

/** The review outcome a persisted ``submit_plan`` result records. */
export function planReviewFromResult(result: string): PlanReviewState {
  let text = result.trim()
  if (text.startsWith(EDITED_PREFIX)) {
    // The user's edited plan comes first; the decision follows it.
    const end = text.lastIndexOf('</plan>')
    text = end >= 0 ? text.slice(end + '</plan>'.length).trim() : ''
  }
  if (text.startsWith('The user approved')) return { kind: 'approved' }
  const feedback = text.match(/^The user requested changes to plan revision \d+:\n\n([\s\S]*?)\n\n(?:You are still in Plan mode\.\s*)?Address every point/)
  if (feedback) return { kind: 'changes', feedback: feedback[1]?.trim() || null }
  if (text.startsWith('The user requested changes')) return { kind: 'changes', feedback: null }
  if (text.startsWith('Error:')) return { kind: 'failed', message: text.slice('Error:'.length).trim() || null }
  return CLOSED_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? { kind: 'closed', reason: null }
}

export function planReviewState({
  open,
  resolved,
  result,
  done,
}: {
  open: boolean
  resolved: ResolvedQuestion | undefined
  result: string | undefined
  done: boolean | undefined
}): PlanReviewState {
  if (open) return { kind: 'waiting' }
  if (resolved) {
    if (resolved.answers === null) return { kind: 'closed', reason: resolved.reason }
    return fromAnswer(resolved.answers[0]?.[0] ?? '')
  }
  const text = (result ?? '').trim()
  if (!text) return done ? { kind: 'waiting' } : { kind: 'submitting' }
  // A cold load mid-review: the row still holds the placeholder.
  if (text.startsWith(PLACEHOLDER_PREFIX)) return { kind: 'waiting' }
  return planReviewFromResult(text)
}

function stateLabel(state: PlanReviewState): string {
  switch (state.kind) {
    case 'submitting':
      return 'Submitting plan…'
    case 'waiting':
      return 'Waiting for your review'
    case 'approved':
      return 'Approved'
    case 'changes':
      return 'Changes requested'
    case 'closed':
      return (state.reason && CLOSED_LABEL[state.reason]) ?? 'Closed without a review'
    case 'not_submitted':
      return 'Not submitted — the agent asked a question first'
    case 'merged':
      return 'Merged into the other plan review'
    case 'failed':
      return state.message ? `Not submitted — ${state.message}` : 'Not submitted'
  }
}

/** The requested changes: each comment under its passage, then the rest. */
function ReviewFeedback({ feedback }: { feedback: string }) {
  const { comments, overall } = parsePlanReview(feedback)
  const shown = comments.slice(0, SHOWN_COMMENTS)
  const hidden = comments.length - shown.length
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((comment, index) => (
        <div key={index} className="flex min-w-0 flex-col gap-0.5">
          {comment.quote && (
            <span className="truncate border-l-2 border-(--color-border-strong) pl-1.5 text-[11px] leading-relaxed text-(--color-text-subtle)">
              {comment.quote.replace(/\s+/g, ' ')}
            </span>
          )}
          {comment.text && (
            <span className="line-clamp-2 text-[11px] leading-relaxed break-words whitespace-pre-line text-(--color-text)">
              {comment.text}
            </span>
          )}
        </div>
      ))}
      {hidden > 0 && (
        <span className="text-[11px] text-(--color-text-subtle)">
          +{hidden} more {hidden === 1 ? 'comment' : 'comments'}
        </span>
      )}
      {overall && (
        <span className="line-clamp-3 text-[11px] leading-relaxed break-words whitespace-pre-line text-(--color-text)">{overall}</span>
      )}
    </div>
  )
}

function commentCount(state: PlanReviewState): number {
  return state.kind === 'changes' && state.feedback ? parsePlanReview(state.feedback).comments.length : 0
}

function parseSummary(args: string | undefined): string | null {
  if (!args) return null
  try {
    const summary = (JSON.parse(args) as { summary?: unknown })?.summary
    return typeof summary === 'string' && summary.trim() ? summary.trim() : null
  } catch {
    return null
  }
}

function revisionIn(text: string | undefined): number | null {
  const match = text?.match(/revision (\d+)/)
  return match ? Number(match[1]) : null
}

/** The ``tool_call_id`` of the plan review open in this session, or ``null``. */
function selectOpenReviewCallId(state: AgentStoreState): string | null {
  const question = state.pendingQuestion
  return question !== null && question.kind === 'plan_review' && state.sessionId !== null && question.sessionId === state.sessionId
    ? question.toolCallId
    : null
}

export function PlanReviewCard({
  toolCallId,
  args,
  result,
  done,
}: {
  toolCallId?: string
  args?: string
  result?: string
  done?: boolean
}) {
  const openCallId = useAgentStore(selectOpenReviewCallId)
  const openRevision = useAgentStore((state) => state.pendingQuestion?.planRevision)
  const resolved = useAgentStore((state) => (toolCallId ? state.resolvedQuestions[toolCallId] : undefined))

  const open = openCallId !== null && openCallId === toolCallId
  const state = planReviewState({ open, resolved, result, done })
  const revision = open ? (openRevision ?? null) : (revisionIn(resolved?.questions[0]?.question) ?? revisionIn(result))
  const summary = parseSummary(args)
  const waiting = state.kind === 'waiting'
  const comments = commentCount(state)
  const canOpen = state.kind !== 'submitting' && state.kind !== 'not_submitted' && state.kind !== 'merged' && state.kind !== 'failed'

  return (
    <div
      data-question-waiting={open ? '' : undefined}
      className="tool-row-enter my-2 overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card)"
    >
      <div className="flex items-center gap-1.5 border-b border-(--color-border) px-3 py-1.5 label-caps text-(--color-text-muted)">
        <FileText size={12} aria-hidden />
        Plan review
        {revision !== null && <span className="font-mono tracking-normal normal-case tabular-nums">rev {revision}</span>}
      </div>
      <div className="flex items-start gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className={cn(
              'text-[11px] leading-relaxed font-medium',
              waiting && 'text-(--accent-orange-text)',
              state.kind === 'approved' && 'text-(--accent-green-text)',
              state.kind === 'submitting' && 'animate-pulse text-(--color-text-muted)',
              !waiting && state.kind !== 'approved' && state.kind !== 'submitting' && 'text-(--color-text-muted)',
            )}
          >
            {stateLabel(state)}
            {comments > 0 && ` · ${comments} ${comments === 1 ? 'comment' : 'comments'}`}
          </span>
          {state.kind === 'changes' && state.feedback && <ReviewFeedback feedback={state.feedback} />}
          {summary && <span className="text-[11px] leading-relaxed break-words text-(--color-text-subtle)">{summary}</span>}
        </div>
        {canOpen && (
          <Button
            type="button"
            variant={open ? 'primary' : 'default'}
            size="xs"
            className="shrink-0"
            onClick={() => dispatchAppEvent(APP_EVENTS.openPlan)}
          >
            {open ? 'Review plan' : 'View plan'}
          </Button>
        )}
      </div>
    </div>
  )
}

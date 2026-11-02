/**
 * Approve and Request changes on the transcript card, for the review that is
 * open: deciding is one click where the plan was submitted, not a trip to the
 * Plan tab (or the phone sheet).
 *
 * It sends what the Plan tab sends (``usePlanDecision``) and reads the same
 * review draft, so line comments written in the tab go with Request changes
 * from here too, and Approve waits while there are any. Request changes opens
 * its text box right here: type, Send.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { useSessionPlanQuery } from '@/queries/useSessionPlanQuery'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion } from '@/api/types'
import { KeepGoingControl } from './KeepGoingControl'
import {
  PLAN_FEEDBACK_MAX_CHARS,
  planReviewAnswer,
  usePlanReviewDraft,
  writePlanReviewDraft,
} from './plan-comments'
import { usePlanDecision } from './usePlanDecision'

export function PlanDecisionBar({ review }: { review: PendingQuestion }) {
  const sessionId = useAgentStore((state) => state.sessionId)
  const { data } = useSessionPlanQuery(sessionId)
  const decision = usePlanDecision({ review, doneWhen: data?.plan?.done_when })
  const draft = usePlanReviewDraft(review.id)
  const [asking, setAsking] = useState(false)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  const answer = planReviewAnswer(draft)
  const tooLong = answer.length > PLAN_FEEDBACK_MAX_CHARS
  const comments = draft.comments.length
  const approveHint = comments > 0 || draft.overall.trim() ? 'Your comments go with Request changes' : decision.turnsProblem
  const commentsLabel = comments > 0 ? `${comments} ${comments === 1 ? 'comment' : 'comments'} on the plan will be sent too` : null

  const ask = () => {
    // Render the box and focus it inside this tap: a touch keyboard opens only
    // for focus within a user gesture.
    flushSync(() => setAsking(true))
    feedbackRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setAsking(false)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !decision.submitting && !tooLong) {
      event.preventDefault()
      decision.requestChanges(answer)
    }
  }

  const keepGoing = decision.canKeepGoing ? <KeepGoingControl decision={decision} className="ml-auto" /> : null

  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      {asking ? (
        <div role="group" aria-label="Request changes" className="flex flex-col gap-2">
          <Textarea
            ref={feedbackRef}
            aria-label="What should change?"
            placeholder={comments > 0 ? 'Anything else? (optional)' : 'What should change?'}
            value={draft.overall}
            maxLength={PLAN_FEEDBACK_MAX_CHARS}
            onChange={(event) => writePlanReviewDraft(review.id, { ...draft, overall: event.target.value })}
            onKeyDown={onKeyDown}
            className="max-h-40 min-h-16 text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            {commentsLabel && <span className="text-xs text-(--color-text-muted)">{commentsLabel}</span>}
            {tooLong && <span className="text-xs text-(--color-error)">Too long to send — shorten your comments</span>}
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={decision.submitting}>
                Cancel
              </Button>
              <Button type="button" variant="primary" size="sm" onClick={() => decision.requestChanges(answer)} disabled={decision.submitting || tooLong}>
                Send
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="primary" size="sm" onClick={decision.approve} disabled={decision.submitting || approveHint !== null}>
            {decision.approveLabel}
          </Button>
          <Button type="button" variant="default" size="sm" onClick={ask} disabled={decision.submitting}>
            {comments > 0 ? `Request changes (${comments})` : 'Request changes'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => dispatchAppEvent(APP_EVENTS.openPlan)}>
            Open plan
          </Button>
          {keepGoing}
        </div>
      )}
      {!asking && approveHint && <p className="text-xs text-(--color-text-muted)">{approveHint}</p>}
      {decision.error && (
        <p role="alert" className="text-xs text-(--color-error)">{decision.error}</p>
      )}
    </div>
  )
}

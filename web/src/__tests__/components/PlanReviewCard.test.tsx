/**
 * PlanReviewCard — the ``submit_plan`` card in the transcript.
 *
 * The review happens in the Plan tab; the card says how it ended. Like the
 * ``ask_user`` card it prefers the outcome recorded in the store, since the
 * persisted result keeps the placeholder until the post-turn reconcile, and
 * falls back to the persisted sentence on a cold load.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { PlanReviewCard, planReviewFromResult } from '@/components/PlanReview/PlanReviewCard'
import { APP_EVENTS } from '@/lib/app-events'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion } from '@/api/types'

const PLACEHOLDER = 'Waiting for the user to answer. Do not continue until their reply arrives.'

const REVIEW: PendingQuestion = {
  id: 'q-1',
  sessionId: 's-1',
  toolCallId: 'call-1',
  kind: 'plan_review',
  planRevision: 3,
  questions: [{ question: 'Review plan revision 3.', header: 'Plan review', multiple: false, options: [] }],
}

beforeEach(() => {
  useAgentStore.setState({ sessionId: 's-1', pendingQuestion: null, resolvedQuestions: {} })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })
})

describe('PlanReviewCard', () => {
  it('waits for the review and opens the plan while its review is open', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openPlan, opened)

    const { container } = render(
      <PlanReviewCard toolCallId="call-1" args='{"summary":"Adds the plan tab"}' result={PLACEHOLDER} done />,
    )

    expect(screen.getByText('Waiting for your review')).toBeTruthy()
    expect(screen.getByText('rev 3')).toBeTruthy()
    expect(screen.getByText('Adds the plan tab')).toBeTruthy()
    expect(container.querySelector('[data-question-waiting]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener(APP_EVENTS.openPlan, opened)
  })

  it('never shows the placeholder written for the model', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)
    expect(container.textContent).not.toContain('Do not continue')
  })

  it('shows the approval recorded here before the transcript catches up', () => {
    useAgentStore.setState({
      resolvedQuestions: { 'call-1': { questions: REVIEW.questions, answers: [['Approve']], reason: null } },
    })

    const { container } = render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)

    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.getByText('rev 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View plan' })).toBeTruthy()
    expect(container.querySelector('[data-question-waiting]')).toBeNull()
  })

  it('shows the requested changes recorded here', () => {
    useAgentStore.setState({
      resolvedQuestions: { 'call-1': { questions: REVIEW.questions, answers: [['Split step 2.']], reason: null } },
    })

    render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)

    expect(screen.getByText('Changes requested')).toBeTruthy()
    expect(screen.getByText('Split step 2.')).toBeTruthy()
  })

  it('shows a review the next message superseded', () => {
    useAgentStore.setState({
      resolvedQuestions: { 'call-1': { questions: REVIEW.questions, answers: null, reason: 'superseded' } },
    })

    render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)

    expect(screen.getByText('Superseded by your next message')).toBeTruthy()
  })

  it('reads the outcome from the persisted result on a cold load', () => {
    render(
      <PlanReviewCard
        toolCallId="call-1"
        result={'The user requested changes to plan revision 2:\n\nAdd a rollback step.\n\nYou are still in Plan mode. Address every point.'}
        done
      />,
    )

    expect(screen.getByText('Changes requested')).toBeTruthy()
    expect(screen.getByText('Add a rollback step.')).toBeTruthy()
    expect(screen.getByText('rev 2')).toBeTruthy()
  })

  it('shows each requested change under the passage it is about', () => {
    const feedback =
      '**Comment 1**\n> Write the migration\n\nMake it reversible.\n\n' +
      '**Comment 2**\n> Wire the endpoint\n\nAdd a test.\n\n' +
      '**Overall**\nOtherwise fine.'
    useAgentStore.setState({
      resolvedQuestions: { 'call-1': { questions: REVIEW.questions, answers: [[feedback]], reason: null } },
    })

    const { container } = render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)

    expect(screen.getByText('Changes requested · 2 comments')).toBeTruthy()
    expect(screen.getByText('Write the migration')).toBeTruthy()
    expect(screen.getByText('Make it reversible.')).toBeTruthy()
    expect(screen.getByText('Otherwise fine.')).toBeTruthy()
    // No raw Markdown on the card.
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('> ')
  })

  it('counts comments beyond the first three', () => {
    const feedback = [1, 2, 3, 4, 5].map((n) => `**Comment ${n}**\n> Step ${n}\n\nFix ${n}.`).join('\n\n')
    useAgentStore.setState({
      resolvedQuestions: { 'call-1': { questions: REVIEW.questions, answers: [[feedback]], reason: null } },
    })

    render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)

    expect(screen.getByText('Fix 3.')).toBeTruthy()
    expect(screen.queryByText('Fix 4.')).toBeNull()
    expect(screen.getByText('+2 more comments')).toBeTruthy()
  })

  it('reads the earlier quote-then-comment feedback as a comment', () => {
    render(
      <PlanReviewCard
        toolCallId="call-1"
        result={'The user requested changes to plan revision 1:\n\n> Adding CLI parsing.\n\nKeep this.\n\nYou are still in Plan mode. Address every point.'}
        done
      />,
    )

    expect(screen.getByText('Changes requested · 1 comment')).toBeTruthy()
    expect(screen.getByText('Adding CLI parsing.')).toBeTruthy()
    expect(screen.getByText('Keep this.')).toBeTruthy()
  })

  it('shows a submit the loop deferred, with no plan to open', () => {
    render(
      <PlanReviewCard
        toolCallId="call-1"
        result="Not submitted: this response also asks the user a question. Call submit_plan again after they answer."
        done
      />,
    )

    expect(screen.getByText('Not submitted — the agent asked a question first')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a failed submit', () => {
    render(<PlanReviewCard toolCallId="call-1" result="Error: submit_plan is only available in Plan mode." done />)
    expect(screen.getByText('Not submitted — submit_plan is only available in Plan mode.')).toBeTruthy()
  })

  it('shows the plan being submitted while the call streams', () => {
    render(<PlanReviewCard toolCallId="call-1" args='{"summ' />)
    expect(screen.getByText('Submitting plan…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not treat another plan review as its own', () => {
    useAgentStore.setState({ pendingQuestion: { ...REVIEW, toolCallId: 'call-2' } })
    const { container } = render(<PlanReviewCard toolCallId="call-1" result="The user approved plan revision 1." done />)
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(container.querySelector('[data-question-waiting]')).toBeNull()
  })
})

describe('planReviewFromResult', () => {
  it('reads an approval that carries the user edits made during review', () => {
    const result =
      'The user edited the plan during review; this is revision 4, saved at .openagentd/plans/a.md:\n\n<plan>\n# A\n</plan>\n\n' +
      'The user approved plan revision 4. The session is now in Code mode with full tool access.'
    expect(planReviewFromResult(result)).toEqual({ kind: 'approved' })
  })

  it('reads an approval in code mode', () => {
    const result =
      'The user approved plan revision 2. Implement the plan in `.openagentd/plans/ship-it.md` from its first step and track progress with `todo_manage`.'
    expect(planReviewFromResult(result)).toEqual({ kind: 'approved' })
  })

  it('reads a change request in code mode', () => {
    const result =
      'The user requested changes to plan revision 2:\n\nDrop step 2.\n\nAddress every point, update the plan with the `plan` tool, then call `submit_plan` again.'
    expect(planReviewFromResult(result)).toEqual({
      kind: 'changes',
      feedback: 'Drop step 2.',
    })
  })

  it('reads a change request without feedback', () => {
    expect(planReviewFromResult('The user requested changes to plan revision 1 without saying what to change.')).toEqual({
      kind: 'changes',
      feedback: null,
    })
  })

  it('reads dismissed, merged and expired closings', () => {
    expect(planReviewFromResult('Question(s) being dismissed.')).toEqual({ kind: 'closed', reason: 'dismissed' })
    expect(planReviewFromResult('Merged into your other submit_plan call.')).toEqual({ kind: 'merged' })
    expect(planReviewFromResult('This question is no longer relevant and was discarded.')).toEqual({ kind: 'closed', reason: 'expired' })
  })
})

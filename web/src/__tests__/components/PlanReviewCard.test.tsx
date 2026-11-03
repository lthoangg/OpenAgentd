/**
 * PlanReviewCard — the ``submit_plan`` card in the transcript.
 *
 * The card says how the review ended and opens the plan; it never decides the
 * review (Approve and Request changes live only in the Plan panel). Like the ``ask_user`` card it prefers the outcome recorded in the
 * store, since the persisted result keeps the placeholder until the post-turn
 * reconcile, and falls back to the persisted sentence on a cold load.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactElement } from 'react'
import { cleanup, fireEvent, render as renderUi, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { PlanReviewCard, planReviewFromResult } from '@/components/PlanReview/PlanReviewCard'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { clearPlanReviewDrafts } from '@/components/PlanReview/plan-comments'
import { resetPlanDecisionChoice } from '@/components/PlanReview/usePlanDecision'
import { APP_EVENTS } from '@/lib/app-events'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion, SessionPlan } from '@/api/types'

/** Kept so a card can render inside the app's providers. */
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return renderUi(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const PLACEHOLDER = 'Waiting for the user to answer. Do not continue until their reply arrives.'

const REVIEW: PendingQuestion = {
  id: 'q-1',
  sessionId: 's-1',
  toolCallId: 'call-1',
  kind: 'plan_review',
  planRevision: 3,
  questions: [{ question: 'Review plan revision 3.', header: 'Plan review', multiple: false, options: [] }],
}

const PLAN: SessionPlan = {
  content: '# Ship it\n\n1. Write the migration',
  updated_at: '2026-01-01T00:00:00Z',
  revision: 3,
  approved_revision: null,
  path: '/repo/project/.agents/plans/ship-it-0000abcd.md',
  workspace_path: '.agents/plans/ship-it-0000abcd.md',
  done_when: 'The endpoint answers and its tests pass.',
}

let calls: { url: string; body: unknown }[] = []
let goalSettings: Record<string, unknown> = {}
let plan: SessionPlan = PLAN
const markTurnResuming = mock(() => {})

beforeEach(() => {
  calls = []
  goalSettings = { max_turns: 50, default_max_turns: 50, token_budget: null, allow_questions: true, keep_going_default: false }
  plan = { ...PLAN }
  clearQuestionDrafts()
  clearPlanReviewDrafts()
  resetPlanDecisionChoice()
  useAgentStore.setState({ sessionId: 's-1', pendingQuestion: null, resolvedQuestions: {}, markTurnResuming })
  globalThis.fetch = mock(async (input: unknown, rawInit?: unknown) => {
    const init = rawInit as RequestInit | undefined
    const url = String(input)
    if (url.includes('/answer')) {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ status: 'answered', resumed: true }))
    }
    if (url.includes('/settings/goals')) return new Response(JSON.stringify(goalSettings))
    if (url.includes('/goal')) return new Response(JSON.stringify({ goal: null }))
    return new Response(JSON.stringify({ plan }))
  }) as typeof fetch
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
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }))
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
    expect(screen.getByRole('button', { name: 'Open plan' })).toBeTruthy()
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
        result={'Not submitted: this response also asks the user a question. Call plan with submit: true after they answer.\nPlan saved as revision 1 (2 lines) at .agents/plans/p.md.'}
        done
      />,
    )

    expect(screen.getByText('Not submitted · the agent asked a question first')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a submit a scheduled run saved without a review', () => {
    render(
      <PlanReviewCard
        toolCallId="call-1"
        result={'Not submitted for review: a scheduled task started this turn, so nobody is there to review it. Decide on your own and explain your choices in your final reply.\nPlan saved as revision 1 (1 line) at .agents/plans/p.md.'}
        done
      />,
    )

    expect(screen.getByText('Not submitted · a scheduled task started this turn')).toBeTruthy()
  })

  it('shows a failed submit', () => {
    render(<PlanReviewCard toolCallId="call-1" result="Error: submit_plan is only available in Plan mode." done />)
    expect(screen.getByText('Not submitted · submit_plan is only available in Plan mode.')).toBeTruthy()
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

describe('PlanReviewCard — no decision in the chat', () => {
  it('offers only Open plan on the open card: Approve and Request changes live in the Plan panel', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Open plan'])
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Request changes/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('PlanReviewCard — look', () => {
  const BORDER = /(?<![\w-:])border-[btlrxy](?![\w-])|(?<![\w-:])border(?![\w-])/

  it('has no icon before the title and one thin frame with nothing bordered inside', () => {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    const { container } = render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)

    const frame = container.querySelector('[data-question-waiting]') as HTMLElement
    expect(frame.className).toContain('border-(--color-border-subtle)')
    expect(Array.from(frame.querySelectorAll('*')).filter((el) => BORDER.test(el.getAttribute('class') ?? '')).map((el) => el.tagName)).toEqual([])
    const title = screen.getByText('Plan review')
    expect(title.querySelector('svg')).toBeNull()
    expect(title.previousElementSibling).toBeNull()
  })

  it('reads the requested changes, the state and the summary at 12px', () => {
    const feedback = '**Comment 1**\n> Write the migration\n\nMake it reversible.\n\n**Overall**\nOtherwise fine.'
    useAgentStore.setState({
      resolvedQuestions: { 'call-1': { questions: REVIEW.questions, answers: [[feedback]], reason: null } },
    })
    render(<PlanReviewCard toolCallId="call-1" args='{"summary":"Adds the plan tab"}' result={PLACEHOLDER} done />)

    for (const text of ['Write the migration', 'Make it reversible.', 'Otherwise fine.', 'Adds the plan tab']) {
      expect(screen.getByText(text).className).toContain('text-xs')
      expect(screen.getByText(text).className).not.toContain('text-meta')
    }
    expect(screen.getByText('Changes requested · 1 comment').className).toContain('text-xs')
  })
})

describe('planReviewFromResult', () => {
  it('reads an approval that carries the user edits made during review', () => {
    const result =
      'The user edited the plan during review; this is revision 4, saved at .agents/plans/a.md:\n\n<plan>\n# A\n</plan>\n\n' +
      'The user approved plan revision 4. The session is now in Code mode with full tool access.'
    expect(planReviewFromResult(result)).toEqual({ kind: 'approved' })
  })

  it('reads an approval in code mode', () => {
    const result =
      'The user approved plan revision 2. Implement the plan in `.agents/plans/ship-it.md` from its first step and track progress with `todo_manage`.'
    expect(planReviewFromResult(result)).toEqual({ kind: 'approved' })
  })

  it('reads a change request in code mode, before and after the tools merged', () => {
    const result =
      'The user requested changes to plan revision 2:\n\nDrop step 2.\n\nAddress every point, update the plan with the `plan` tool, then call `submit_plan` again.'
    expect(planReviewFromResult(result)).toEqual({
      kind: 'changes',
      feedback: 'Drop step 2.',
    })
    const merged =
      'The user requested changes to plan revision 2:\n\nDrop step 2.\n\nAddress every point, update the plan with the `plan` tool, then submit it again with `submit: true`.'
    expect(planReviewFromResult(merged)).toEqual({ kind: 'changes', feedback: 'Drop step 2.' })
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
    expect(planReviewFromResult('Merged into your later plan submission in this response.\nPlan saved as revision 1 (1 line) at p.md.')).toEqual({
      kind: 'merged',
    })
    expect(planReviewFromResult('This question is no longer relevant and was discarded.')).toEqual({ kind: 'closed', reason: 'expired' })
  })
})

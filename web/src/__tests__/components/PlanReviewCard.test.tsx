/**
 * PlanReviewCard — the ``submit_plan`` card in the transcript.
 *
 * The card says how the review ended and opens the plan; while its review is
 * open it also decides it (Approve, Request changes with a comment typed right
 * there). Like the ``ask_user`` card it prefers the outcome recorded in the
 * store, since the persisted result keeps the placeholder until the post-turn
 * reconcile, and falls back to the persisted sentence on a cold load.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactElement } from 'react'
import { cleanup, fireEvent, render as renderUi, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { PlanReviewCard, planReviewFromResult } from '@/components/PlanReview/PlanReviewCard'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { clearPlanReviewDrafts, readPlanReviewDraft, writePlanReviewDraft } from '@/components/PlanReview/plan-comments'
import { resetPlanDecisionChoice } from '@/components/PlanReview/usePlanDecision'
import { APP_EVENTS } from '@/lib/app-events'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion, SessionPlan } from '@/api/types'

/** The decision bar reads the plan and the goal settings, so a card needs a query client. */
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

describe('PlanReviewCard — deciding on the card', () => {
  const answers = () => calls.filter((call) => call.url.includes('/question/q-1/answer'))

  function renderOpen() {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    return render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)
  }

  it('puts Approve, Request changes and Open plan on the open card', () => {
    renderOpen()

    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open plan' })).toBeTruthy()
  })

  it('approves from the card with the answer the Plan tab sends, and marks the turn as resuming', async () => {
    renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({ answers: [['Approve']] })
    await waitFor(() => expect(markTurnResuming).toHaveBeenCalledTimes(1))
    expect(useAgentStore.getState().pendingQuestion).toBeNull()
  })

  it('leaves a decided or unrelated card without decision buttons', () => {
    useAgentStore.setState({ pendingQuestion: { ...REVIEW, toolCallId: 'call-2' } })
    render(<PlanReviewCard toolCallId="call-1" result="The user approved plan revision 1." done />)

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull()
  })

  it('opens a text box on the card for Request changes: type, then Send', async () => {
    renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    const box = screen.getByLabelText('What should change?')
    expect(document.activeElement).toBe(box)
    // One decision at a time: the approve action steps aside.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.change(box, { target: { value: '  Split step 2.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({ answers: [['Split step 2.']] })
  })

  it('sends Request changes with no text as the bare option', async () => {
    renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({ answers: [['Request changes']] })
  })

  it('sends from the box with Cmd or Ctrl+Enter, and closes it with Escape or Cancel', async () => {
    renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    fireEvent.keyDown(screen.getByLabelText('What should change?'), { key: 'Escape' })
    expect(screen.queryByLabelText('What should change?')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('What should change?')).toBeNull()
    expect(answers()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    const box = screen.getByLabelText('What should change?')
    fireEvent.change(box, { target: { value: 'Add a rollback.' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({ answers: [['Add a rollback.']] })
  })

  it('keeps what is typed in the review draft the Plan tab shares', () => {
    renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'Needs tests.' } })

    expect(readPlanReviewDraft('q-1').overall).toBe('Needs tests.')
  })

  it('sends the comments written in the Plan tab with Request changes, and holds Approve for them', async () => {
    writePlanReviewDraft('q-1', { comments: [{ id: 'c1', quote: 'Write the migration', text: 'Make it reversible.' }], overall: '' })
    renderOpen()

    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Your comments go with Request changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes (1)' }))
    expect(screen.getByText('1 comment on the plan will be sent too')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'And split step 2.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({
      answers: [['**Comment 1**\n> Write the migration\n\nMake it reversible.\n\n**Overall**\nAnd split step 2.']],
    })
  })

  it('holds Send back when the review is too long to send', () => {
    writePlanReviewDraft('q-1', { comments: [], overall: 'x'.repeat(8001) })
    renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))

    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Too long to send — shorten your comments')).toBeTruthy()
  })

  it('shows a failed answer on the card and keeps it open', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/answer')) return new Response(JSON.stringify({ detail: 'The server is down.' }), { status: 500 })
      if (url.includes('/settings/goals')) return new Response(JSON.stringify(goalSettings))
      return new Response(JSON.stringify({ plan }))
    }) as typeof fetch
    renderOpen()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect((await screen.findByRole('alert')).textContent).toContain('The server is down.')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })
})

describe('PlanReviewCard — Keep going', () => {
  const answers = () => calls.filter((call) => call.url.includes('/question/q-1/answer'))

  function renderOpen() {
    useAgentStore.setState({ pendingQuestion: REVIEW })
    return render(<PlanReviewCard toolCallId="call-1" result={PLACEHOLDER} done />)
  }

  it('says what Approve will do: "Approve and keep going (N turns)" with the turns from Settings', async () => {
    goalSettings = { ...goalSettings, keep_going_default: true, max_turns: 30 }
    renderOpen()

    const approve = await screen.findByRole('button', { name: 'Approve and keep going (30 turns)' })
    fireEvent.click(approve)

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({ answers: [['Approve']], keep_going: {} })
  })

  it('starts unticked by default, and plain Approve starts no goal', async () => {
    renderOpen()

    const keepGoing = (await screen.findByRole('checkbox', { name: 'Keep going until done' })) as HTMLInputElement
    expect(keepGoing.checked).toBe(false)
    expect(screen.queryByLabelText('Turns for this goal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({ answers: [['Approve']] })
  })

  it('changes the label and the turns sent when the reader ticks it and edits the turns', async () => {
    renderOpen()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep going until done' }))
    expect(screen.getByRole('button', { name: 'Approve and keep going (50 turns)' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Turns for this goal'), { target: { value: '1' } })
    expect(screen.getByRole('button', { name: 'Approve and keep going (1 turn)' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Turns for this goal'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve and keep going (20 turns)' }))

    await waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]?.body).toEqual({ answers: [['Approve']], keep_going: { max_turns: 20 } })
  })

  it('blocks Approve on turns out of range, with the reason on screen', async () => {
    renderOpen()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep going until done' }))
    fireEvent.change(screen.getByLabelText('Turns for this goal'), { target: { value: '0' } })

    expect((screen.getByRole('button', { name: 'Approve and keep going' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Turns: a whole number from 1 to 1000')).toBeTruthy()
  })

  it('offers no Keep going when the plan has no Done when', async () => {
    plan = { ...PLAN, done_when: null }
    renderOpen()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(screen.queryByRole('checkbox', { name: 'Keep going until done' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
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

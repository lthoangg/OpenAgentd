/**
 * AskUser — the inline transcript card.
 *
 * It renders in the tool call's place, so which of its two states it shows is
 * decided per *tool call*, not per session: an old question further up the
 * transcript must stay resolved while a new one below it is open.
 *
 * The other thing under test is the gap between answering and the post-turn
 * reconcile. The persisted tool result is only rewritten server-side, so for
 * the rest of the turn the row still says "waiting for the user" — the card has
 * to prefer the locally recorded outcome or it shows the wrong state for
 * seconds at a time.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const answerQuestion = mock(async () => ({ status: 'answered', resumed: true }))
const dismissQuestion = mock(async () => ({ status: 'dismissed', resumed: false }))
// `markTurnResuming` may reopen the session stream after an answer.
const agentStream = mock(() => {})
mock.module('@/api/client', () => ({ answerQuestion, dismissQuestion, agentStream }))

const pushToast = mock(() => {})
mock.module('@/stores/useToastStore', () => ({
  useToastStore: { getState: () => ({ push: pushToast }) },
}))

import { AskUser } from '@/components/AskUser'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion } from '@/api/types'

const PLACEHOLDER =
  'Waiting for the user to answer. Do not continue until their reply arrives.'

const QUESTION: PendingQuestion = {
  id: 'q-1',
  sessionId: 's-1',
  toolCallId: 'call-1',
  questions: [
    {
      question: 'Which package manager?',
      header: 'Package manager',
      multiple: false,
      custom: false,
      options: [
        { label: 'pnpm', description: null, recommended: true },
        { label: 'bun', description: null, recommended: false },
      ],
    },
  ],
}

beforeEach(() => {
  answerQuestion.mockClear()
  dismissQuestion.mockClear()
  pushToast.mockClear()
  answerQuestion.mockImplementation(async () => ({ status: 'answered', resumed: true }))
  dismissQuestion.mockImplementation(async () => ({ status: 'dismissed', resumed: false }))
  clearQuestionDrafts()
  useAgentStore.setState({
    sessionId: 's-1',
    isConnected: true,
    pendingQuestion: QUESTION,
    resolvedQuestions: {},
  })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })
})

describe('AskUser — waiting state', () => {
  it('shows the form for the tool call that owns the open question', () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByRole('radio', { name: /pnpm/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send answer/i })).toBeInTheDocument()
  })

  it('does not show the form on a different tool call', () => {
    render(<AskUser toolCallId="call-OTHER" result={PLACEHOLDER} />)

    expect(screen.queryByRole('radio', { name: /pnpm/ })).toBeNull()
  })

  it('never renders the placeholder written for the model', () => {
    const { container } = render(
      <AskUser toolCallId="call-1" result={PLACEHOLDER} />,
    )

    expect(container.textContent).not.toContain('Do not continue')
  })

  it('offers no collapse control — an open question must not be hideable', () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(buttons.some((label) => /expand|collapse|show more/i.test(label))).toBe(false)
  })

  it('posts the answer for the open question', async () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0]).toEqual(['s-1', 'q-1', [['bun']]])
    await waitFor(() => expect(useAgentStore.getState().pendingQuestion).toBeNull())
  })

  it('dismisses without sending an answer', async () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    await waitFor(() => expect(dismissQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion).not.toHaveBeenCalled()
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('warns when the answer saved but the turn did not restart', async () => {
    answerQuestion.mockImplementation(async () => ({ status: 'answered', resumed: false }))
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(pushToast).toHaveBeenCalledTimes(1))
  })

  it('keeps the form and the selection when the answer fails to send', async () => {
    answerQuestion.mockImplementation(async () => { throw new Error('Network unreachable') })
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network unreachable'))
    expect(screen.getByRole('radio', { name: /bun/ })).toBeChecked()
  })

  /**
   * 409 is the server saying the question is not open any more — another
   * window or device already resolved it, or a new message superseded it. The
   * form cannot succeed on retry (the row is gone), so keeping it up with an
   * error strands the user until a reload. Close the card instead; the
   * persisted result shows the real outcome on the next history load.
   */
  it('closes the card when the server says the question is already resolved', async () => {
    answerQuestion.mockImplementation(async () => {
      throw Object.assign(new Error('Question already resolved.'), { status: 409 })
    })
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(useAgentStore.getState().pendingQuestion).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: /send answer/i })).toBeNull()
    expect(screen.queryByText(/needs your input/i)).toBeNull()
    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('closes the card when a dismissal finds the question already resolved', async () => {
    dismissQuestion.mockImplementation(async () => {
      throw Object.assign(new Error('Question is not open.'), { status: 409 })
    })
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    await waitFor(() => expect(useAgentStore.getState().pendingQuestion).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('AskUser — resolved state', () => {
  it('shows the answer immediately, before the tool result is rewritten', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: [['bun']], reason: null },
      },
    })

    const { container } = render(
      // Still the placeholder: the server rewrites it only when the turn ends.
      <AskUser toolCallId="call-1" result={PLACEHOLDER} />,
    )

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByText('bun')).toBeInTheDocument()
    expect(container.textContent).not.toContain('Waiting for the user')
  })

  it('reports a dismissal', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: null, reason: 'dismissed' },
      },
    })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/dismissed/i)).toBeInTheDocument()
  })

  it('marks a question the user skipped', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: [[]], reason: null },
      },
    })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/skipped/i)).toBeInTheDocument()
  })

  it('parses the persisted sentence on a cold load, dropping the model instructions', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    const { container } = render(
      <AskUser
        toolCallId="call-1"
        result={
          'User has answered your questions: "Which package manager?"="pnpm". ' +
          "Continue with the user's answers in mind."
        }
      />,
    )

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByText('pnpm')).toBeInTheDocument()
    expect(container.textContent).not.toContain('Continue with')
  })

  it('says it is waiting when a cold load lands mid-question', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/waiting for an answer/i)).toBeInTheDocument()
  })

  it('shows a dismissal recorded on the server', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(
      <AskUser toolCallId="call-1" result="Question(s) being dismissed." />,
    )

    expect(screen.getByText(/dismissed/i)).toBeInTheDocument()
  })
})

/**
 * Resolving is a race: the POST reply and the broadcast of the same resolution
 * arrive independently, and either can land first. Whichever wins has to record
 * the outcome, because the loser finds nothing left to match on — and a card
 * with no recorded outcome falls back to "waiting", which is the one state that
 * is definitely wrong once the user has acted.
 */
describe('AskUser — resolution ordering', () => {
  it('keeps the answer when the POST reply beats the broadcast', async () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))
    await waitFor(() => expect(useAgentStore.getState().pendingQuestion).toBeNull())

    // The broadcast lands afterwards, with the open question already closed.
    useAgentStore.getState()._handleSSEEvent('question_answered', {
      question_id: 'q-1',
      session_id: 's-1',
      answers: [['bun']],
    })

    await waitFor(() => expect(screen.getByText('bun')).toBeInTheDocument())
    expect(screen.queryByText(/waiting for an answer/i)).toBeNull()
  })

  it('keeps the dismissal when the POST reply beats the broadcast', async () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(useAgentStore.getState().pendingQuestion).toBeNull())

    useAgentStore.getState()._handleSSEEvent('question_dismissed', {
      question_id: 'q-1',
      session_id: 's-1',
      reason: 'dismissed',
    })

    await waitFor(() => expect(screen.getByText(/dismissed/i)).toBeInTheDocument())
    expect(screen.queryByText(/waiting for an answer/i)).toBeNull()
  })

  it('keeps the answer when the broadcast beats the POST reply', async () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    useAgentStore.getState()._handleSSEEvent('question_answered', {
      question_id: 'q-1',
      session_id: 's-1',
      answers: [['bun']],
    })
    // The local path still runs and must not undo what the broadcast recorded.
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(screen.getByText('bun')).toBeInTheDocument())
    expect(screen.queryByText(/waiting for an answer/i)).toBeNull()
  })
})

/**
 * A question that ended without an answer still has to say *what was asked*.
 * "Dismissed" on its own is unreadable weeks later, and it is the one case
 * where the transcript holds no answer text to infer the question from.
 * Minimised: the question lines only, no options and no controls.
 */
describe('AskUser — closed without an answer', () => {
  it('still lists the questions it asked when dismissed', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: null, reason: 'dismissed' },
      },
    })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByText(/dismissed/i)).toBeInTheDocument()
  })

  it('distinguishes a superseded question from a dismissal', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: null, reason: 'superseded' },
      },
    })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByText(/superseded/i)).toBeInTheDocument()
  })

  it('stays minimised — no options and no controls survive the resolution', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: null, reason: 'dismissed' },
      },
    })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('pnpm')).toBeNull()
  })

  it('recovers the questions from the tool call args on a cold load', () => {
    // Nothing in the store and nothing in the result sentence: the args are the
    // only surviving record of what was asked.
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(
      <AskUser
        toolCallId="call-1"
        args={JSON.stringify({ questions: QUESTION.questions })}
        result="Question(s) being dismissed."
      />,
    )

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByText(/dismissed/i)).toBeInTheDocument()
  })

  it('reads a superseded resolution back from the persisted sentence', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(
      <AskUser
        toolCallId="call-1"
        args={JSON.stringify({ questions: QUESTION.questions })}
        result="Superseded — the user sent a new instruction instead of answering."
      />,
    )

    expect(screen.getByText(/superseded/i)).toBeInTheDocument()
    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
  })

  it('survives unparseable tool call args', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(
      <AskUser
        toolCallId="call-1"
        args="{not json"
        result="Question(s) being dismissed."
      />,
    )

    expect(screen.getByText(/dismissed/i)).toBeInTheDocument()
  })

  /**
   * The agent loop refuses a second ``ask_user`` in a resumed turn and writes
   * ``ASK_BUDGET_EXHAUSTED`` as the tool result (core.py). The card must not
   * present that as a question the user somehow missed — nothing was ever
   * open, so "Closed without an answer" reads as a bug.
   */
  it('labels a budget-refused ask as not asked, not as closed without an answer', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    const { container } = render(
      <AskUser
        toolCallId="call-1"
        args={JSON.stringify({ questions: QUESTION.questions })}
        result={
          'You already used your one interruption for this turn. Continue with your ' +
          'best judgment, or finish and raise anything outstanding in your reply.'
        }
      />,
    )

    expect(container.textContent).not.toContain('Closed without an answer')
    expect(screen.getByText(/not asked/i)).toBeInTheDocument()
    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    // Resolved framing, not an outstanding request.
    expect(screen.queryByText(/needs your input/i)).toBeNull()
  })

  /**
   * Parallel ``ask_user`` calls are folded into one card; the duplicates get
   * ``ASK_MERGED_INTO_PRIMARY`` as their result. Same rule: never "Closed
   * without an answer" for a question the primary card actually carried.
   */
  it('labels a merged duplicate ask as merged, not as closed without an answer', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    const { container } = render(
      <AskUser
        toolCallId="call-2"
        args={JSON.stringify({ questions: QUESTION.questions })}
        result={
          'Merged into your other ask_user call — the user sees a single card ' +
          'with every question.'
        }
      />,
    )

    expect(container.textContent).not.toContain('Closed without an answer')
    expect(screen.getByText(/merged/i)).toBeInTheDocument()
    expect(screen.queryByText(/needs your input/i)).toBeNull()
  })
})

/**
 * Loop-side endings that never opened a question. Each writes its own
 * sentence onto the tool row (schema validation runs before the tool body,
 * ``ask_user`` refuses without a call id, and a restart heals the orphaned
 * call with a stub) — none of which involve the user, so "Closed without an
 * answer" misreports every one of them as a question the user lost.
 */
describe('AskUser — asks that failed before a question opened', () => {
  it('labels an args-validation failure as never asked', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    const { container } = render(
      <AskUser
        toolCallId="call-1"
        args={JSON.stringify({ questions: QUESTION.questions })}
        result={
          "Error: Invalid arguments for tool 'ask_user': questions -> 3 -> " +
          'options -> 0 -> description: String should have at most 200 characters'
        }
      />,
    )

    expect(container.textContent).not.toContain('Closed without an answer')
    expect(screen.getByText(/not asked/i)).toBeInTheDocument()
    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.queryByText(/needs your input/i)).toBeNull()
  })

  it('labels an undeliverable ask (no tool call id) as never asked', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    const { container } = render(
      <AskUser
        toolCallId="call-1"
        args={JSON.stringify({ questions: QUESTION.questions })}
        result={
          'Your question could not be delivered (no tool call id). ' +
          'Continue with your best judgment.'
        }
      />,
    )

    expect(container.textContent).not.toContain('Closed without an answer')
    expect(screen.getByText(/not asked/i)).toBeInTheDocument()
    expect(screen.queryByText(/needs your input/i)).toBeNull()
  })

  it('labels a restart-healed ask as interrupted, not closed without an answer', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    const { container } = render(
      <AskUser
        toolCallId="call-1"
        args={JSON.stringify({ questions: QUESTION.questions })}
        result="Tool execution was interrupted before a result could be recorded."
      />,
    )

    expect(container.textContent).not.toContain('Closed without an answer')
    expect(screen.getByText(/interrupted/i)).toBeInTheDocument()
    expect(screen.queryByText(/needs your input/i)).toBeNull()
  })
})

/**
 * The card's own label has to track the same two states as its body — a
 * resolved question still headed "Needs your input" reads as an outstanding
 * request the user has to act on.
 */
describe('AskUser — card label', () => {
  it('asks for input while the question is open', () => {
    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/needs your input/i)).toBeInTheDocument()
  })

  it('stops asking for input once the question is answered', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: [['bun']], reason: null },
      },
    })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.queryByText(/needs your input/i)).toBeNull()
    expect(screen.getByText(/your input/i)).toBeInTheDocument()
  })

  it('stops asking for input once the question is dismissed', () => {
    useAgentStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: null, reason: 'dismissed' },
      },
    })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.queryByText(/needs your input/i)).toBeNull()
  })

  it('still asks for input when a cold load lands mid-question', () => {
    useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(<AskUser toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/needs your input/i)).toBeInTheDocument()
  })
})

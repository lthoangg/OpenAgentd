/**
 * AskUserQuestion — the inline transcript card.
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
mock.module('@/api/client', () => ({ answerQuestion, dismissQuestion }))

const pushToast = mock(() => {})
mock.module('@/stores/useToastStore', () => ({
  useToastStore: { getState: () => ({ push: pushToast }) },
}))

import { AskUserQuestion } from '@/components/AskUserQuestion'
import { clearQuestionDrafts } from '@/components/AskUserQuestion/draft-cache'
import { useTeamStore } from '@/stores/useTeamStore'
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
  useTeamStore.setState({
    sessionId: 's-1',
    pendingQuestion: QUESTION,
    resolvedQuestions: {},
  })
})

afterEach(() => {
  cleanup()
  useTeamStore.setState({ pendingQuestion: null, resolvedQuestions: {} })
})

describe('AskUserQuestion — waiting state', () => {
  it('shows the form for the tool call that owns the open question', () => {
    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByRole('radio', { name: /pnpm/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send answer/i })).toBeInTheDocument()
  })

  it('does not show the form on a different tool call', () => {
    render(<AskUserQuestion toolCallId="call-OTHER" result={PLACEHOLDER} />)

    expect(screen.queryByRole('radio', { name: /pnpm/ })).toBeNull()
  })

  it('never renders the placeholder written for the model', () => {
    const { container } = render(
      <AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />,
    )

    expect(container.textContent).not.toContain('Do not continue')
  })

  it('offers no collapse control — an open question must not be hideable', () => {
    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(buttons.some((label) => /expand|collapse|show more/i.test(label))).toBe(false)
  })

  it('posts the answer for the open question', async () => {
    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0]).toEqual(['s-1', 'q-1', [['bun']]])
    await waitFor(() => expect(useTeamStore.getState().pendingQuestion).toBeNull())
  })

  it('dismisses without sending an answer', async () => {
    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    await waitFor(() => expect(dismissQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion).not.toHaveBeenCalled()
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('warns when the answer saved but the turn did not restart', async () => {
    answerQuestion.mockImplementation(async () => ({ status: 'answered', resumed: false }))
    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(pushToast).toHaveBeenCalledTimes(1))
  })

  it('keeps the form and the selection when the answer fails to send', async () => {
    answerQuestion.mockImplementation(async () => { throw new Error('Network unreachable') })
    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network unreachable'))
    expect(screen.getByRole('radio', { name: /bun/ })).toBeChecked()
  })
})

describe('AskUserQuestion — resolved state', () => {
  it('shows the answer immediately, before the tool result is rewritten', () => {
    useTeamStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: [['bun']] },
      },
    })

    const { container } = render(
      // Still the placeholder: the server rewrites it only when the turn ends.
      <AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />,
    )

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByText('bun')).toBeInTheDocument()
    expect(container.textContent).not.toContain('Waiting for the user')
  })

  it('reports a dismissal', () => {
    useTeamStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: null },
      },
    })

    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/dismissed/i)).toBeInTheDocument()
  })

  it('marks a question the user skipped', () => {
    useTeamStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: [[]] },
      },
    })

    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/skipped/i)).toBeInTheDocument()
  })

  it('parses the persisted sentence on a cold load, dropping the model instructions', () => {
    useTeamStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    const { container } = render(
      <AskUserQuestion
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
    useTeamStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/waiting for an answer/i)).toBeInTheDocument()
  })

  it('shows a dismissal recorded on the server', () => {
    useTeamStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(
      <AskUserQuestion toolCallId="call-1" result="Question(s) being dismissed." />,
    )

    expect(screen.getByText(/dismissed/i)).toBeInTheDocument()
  })
})

/**
 * The card's own label has to track the same two states as its body — a
 * resolved question still headed "Needs your input" reads as an outstanding
 * request the user has to act on.
 */
describe('AskUserQuestion — card label', () => {
  it('asks for input while the question is open', () => {
    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/needs your input/i)).toBeInTheDocument()
  })

  it('stops asking for input once the question is answered', () => {
    useTeamStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: [['bun']] },
      },
    })

    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.queryByText(/needs your input/i)).toBeNull()
    expect(screen.getByText(/your input/i)).toBeInTheDocument()
  })

  it('stops asking for input once the question is dismissed', () => {
    useTeamStore.setState({
      pendingQuestion: null,
      resolvedQuestions: {
        'call-1': { questions: QUESTION.questions, answers: null },
      },
    })

    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.queryByText(/needs your input/i)).toBeNull()
  })

  it('still asks for input when a cold load lands mid-question', () => {
    useTeamStore.setState({ pendingQuestion: null, resolvedQuestions: {} })

    render(<AskUserQuestion toolCallId="call-1" result={PLACEHOLDER} />)

    expect(screen.getByText(/needs your input/i)).toBeInTheDocument()
  })
})

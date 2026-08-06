/**
 * QuestionDock — store/API wiring around QuestionCard.
 *
 * The card itself is covered in QuestionCard.test.tsx; what matters here is what
 * happens around a resolution: the card closes locally (not only via SSE, which
 * a reconnecting client may never deliver to itself), a failure keeps the card
 * on screen so the selection can be retried, and a question belonging to another
 * session never renders.
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

import { QuestionDock } from '@/components/QuestionDock'
import { clearQuestionDrafts } from '@/components/QuestionDock/draft-cache'
import { useTeamStore } from '@/stores/useTeamStore'
import type { PendingQuestion } from '@/api/types'

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
  useTeamStore.setState({ sessionId: 's-1', pendingQuestion: QUESTION })
})

afterEach(() => {
  cleanup()
  useTeamStore.setState({ pendingQuestion: null })
})

describe('QuestionDock', () => {
  it('renders nothing when no question is pending', () => {
    useTeamStore.setState({ pendingQuestion: null })
    const { container } = render(<QuestionDock />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a question belonging to another session', () => {
    useTeamStore.setState({ sessionId: 'other' })
    const { container } = render(<QuestionDock />)

    expect(container).toBeEmptyDOMElement()
  })

  it('posts the answer for the open question and closes the card', async () => {
    render(<QuestionDock />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0]).toEqual(['s-1', 'q-1', [['bun']]])
    await waitFor(() => expect(useTeamStore.getState().pendingQuestion).toBeNull())
  })

  it('warns when the answer was saved but the turn did not restart', async () => {
    answerQuestion.mockImplementation(async () => ({ status: 'answered', resumed: false }))
    render(<QuestionDock />)

    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(pushToast).toHaveBeenCalledTimes(1))
    expect(pushToast.mock.calls[0][0]).toMatchObject({ tone: 'error' })
  })

  it('stays silent when the turn resumed', async () => {
    render(<QuestionDock />)

    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(answerQuestion).toHaveBeenCalled())
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('keeps the card open and reports the failure when the answer does not land', async () => {
    answerQuestion.mockImplementation(async () => { throw new Error('Network unreachable') })
    render(<QuestionDock />)

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network unreachable'))
    expect(useTeamStore.getState().pendingQuestion).not.toBeNull()
    // The selection survives, so retrying does not mean re-picking.
    expect(screen.getByRole('radio', { name: /bun/ })).toBeChecked()
  })

  it('dismisses the question without sending an answer', async () => {
    render(<QuestionDock />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    await waitFor(() => expect(dismissQuestion).toHaveBeenCalledTimes(1))
    expect(dismissQuestion.mock.calls[0]).toEqual(['s-1', 'q-1'])
    expect(answerQuestion).not.toHaveBeenCalled()
    await waitFor(() => expect(useTeamStore.getState().pendingQuestion).toBeNull())
  })

  it('does not warn about a missing resume when the user dismissed the question', async () => {
    render(<QuestionDock />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    await waitFor(() => expect(dismissQuestion).toHaveBeenCalled())
    // `resumed: false` is the expected outcome of a dismissal, not a problem.
    expect(pushToast).not.toHaveBeenCalled()
  })
})

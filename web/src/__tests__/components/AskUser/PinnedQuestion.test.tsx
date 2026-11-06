/**
 * On a phone the open ask_user question is pinned above the composer, so it
 * cannot scroll away; the transcript keeps a one-line note in its place
 * (mockup J6 6.1). Plan reviews are not pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { AskUser, PinnedQuestion } = await import('@/components/AskUser')
const { useAgentStore } = await import('@/stores/useAgentStore')

const QUESTION = {
  id: 'q-1',
  sessionId: 's-1',
  toolCallId: 'call-1',
  questions: [{
    question: 'Where should I save the results?',
    header: 'Save',
    multiple: false,
    options: [{ label: 'Markdown in the repo', description: null, recommended: true }],
  }],
}

beforeEach(() => {
  useAgentStore.setState({ sessionId: 's-1', pendingQuestion: QUESTION as never, resolvedQuestions: {} })
})
afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null })
})

describe('PinnedQuestion on a phone', () => {
  it('pins the open question above the composer', () => {
    render(<PinnedQuestion />)
    const pinned = document.querySelector('[data-question-pinned]')
    expect(pinned).toBeTruthy()
    expect(screen.getByText('Where should I save the results?')).toBeTruthy()
  })

  it('leaves a note in the transcript instead of a second form', () => {
    render(<AskUser toolCallId="call-1" />)
    expect(screen.getByText('Answer below')).toBeTruthy()
    expect(screen.queryByText('Where should I save the results?')).toBeNull()
  })

  it('does not pin a plan review', () => {
    useAgentStore.setState({ pendingQuestion: { ...QUESTION, kind: 'plan_review' } as never })
    const { container } = render(<PinnedQuestion />)
    expect(container.textContent).toBe('')
  })
})

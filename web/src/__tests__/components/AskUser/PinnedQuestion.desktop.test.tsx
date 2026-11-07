/**
 * On desktop too, the open ask_user question is pinned above the composer so
 * it cannot scroll away while the run waits on it (desktop mockup 6.1). The
 * transcript keeps "Answer below" where the question was asked.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => false }))

const { AskUser, PinnedQuestion } = await import('@/components/AskUser')
const { useAgentStore } = await import('@/stores/useAgentStore')

const QUESTION = {
  id: 'q-1',
  sessionId: 's-1',
  toolCallId: 'call-1',
  questions: [{
    question: 'Which branch should I rebase onto?',
    header: 'Branch',
    multiple: false,
    options: [{ label: 'main', description: null, recommended: true }],
  }],
}

beforeEach(() => {
  useAgentStore.setState({ sessionId: 's-1', pendingQuestion: QUESTION as never, resolvedQuestions: {} })
})
afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null })
})

describe('PinnedQuestion on desktop', () => {
  it('pins the open question above the composer', () => {
    render(<PinnedQuestion />)
    expect(document.querySelector('[data-question-pinned]')).toBeTruthy()
    expect(screen.getByText('Which branch should I rebase onto?')).toBeTruthy()
  })

  it('answers by number key from the pinned card', () => {
    render(<PinnedQuestion />)
    expect(screen.getByRole('radio', { name: /main/ }).getAttribute('aria-keyshortcuts')).toBe('1')
  })

  it('leaves a note in the transcript instead of a second form', () => {
    render(<><AskUser toolCallId="call-1" /><PinnedQuestion /></>)
    expect(screen.getByText('Answer below')).toBeTruthy()
    expect(screen.getAllByText('Which branch should I rebase onto?')).toHaveLength(1)
    expect(document.querySelector('[data-question-pinned]')?.textContent).toContain('Which branch should I rebase onto?')
  })

  it('answers in place where no composer holds the pinned card', () => {
    render(<AskUser toolCallId="call-1" />)
    expect(screen.queryByText('Answer below')).toBeNull()
    expect(screen.getByText('Which branch should I rebase onto?')).toBeTruthy()
  })
})

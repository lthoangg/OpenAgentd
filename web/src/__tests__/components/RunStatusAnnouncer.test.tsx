import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { RunStatusAnnouncer } from '@/components/RunStatusAnnouncer'
import { useAgentStore } from '@/stores/useAgentStore'
import { runOf } from '@/stores/useAgentStore/run-state'
import { questionCardOf } from '@/stores/useAgentStore/question-state'

const question = {
  id: 'q1',
  sessionId: 's1',
  toolCallId: 'c1',
  questions: [{ question: 'Which branch?', header: 'Branch', options: [], multiple: false }],
}

beforeEach(() => {
  useAgentStore.setState({ sessionId: 's1', sessionRun: runOf(false), questionCard: questionCardOf(null) })
})
afterEach(cleanup)

describe('RunStatusAnnouncer', () => {
  it('says nothing on first render', () => {
    useAgentStore.setState({ sessionRun: runOf(true) })
    render(<RunStatusAnnouncer />)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('announces when the agent starts and finishes a turn', () => {
    render(<RunStatusAnnouncer />)
    act(() => useAgentStore.setState({ sessionRun: runOf(true) }))
    expect(screen.getByRole('status').textContent).toBe('Agent is working')
    act(() => useAgentStore.setState({ sessionRun: runOf(false) }))
    expect(screen.getByRole('status').textContent).toBe('Turn finished')
  })

  it('announces a question that needs the user', () => {
    render(<RunStatusAnnouncer />)
    act(() => useAgentStore.setState({ questionCard: questionCardOf(question) }))
    expect(screen.getByRole('status').textContent).toBe('Needs you: Which branch?')
  })

  it('stays quiet when switching to another session', () => {
    render(<RunStatusAnnouncer />)
    act(() => useAgentStore.setState({ sessionId: 's2', sessionRun: runOf(true) }))
    expect(screen.getByRole('status').textContent).toBe('')
  })
})

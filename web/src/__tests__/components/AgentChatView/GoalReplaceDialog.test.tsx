import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionGoal } from '@/api/types'
import { GoalReplaceDialog } from '@/components/AgentChatView/GoalReplaceDialog'

afterEach(cleanup)

const goal: SessionGoal = {
  id: 'g1', session_id: 's1', objective: 'Make `bun test` pass.', status: 'paused', pause_reason: 'user', detail: null,
  max_turns: 50, token_budget: null, turns_used: 7, tokens_used: 0, active_seconds: 0, rejected_claims: 0,
  created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:01:00Z', ended_at: null,
}

describe('GoalReplaceDialog', () => {
  it('names the goal it would replace, with its progress', () => {
    render(<GoalReplaceDialog current={goal} onConfirm={mock(() => {})} onCancel={mock(() => {})} />)
    expect(screen.getByText(/already has a paused goal \(7 of 50 turns used\)/)).toBeTruthy()
    expect(screen.getByText('bun test').tagName).toBe('CODE')
  })

  it('keeps that goal on screen while it closes', () => {
    const { rerender } = render(<GoalReplaceDialog current={goal} onConfirm={mock(() => {})} onCancel={mock(() => {})} />)
    rerender(<GoalReplaceDialog current={null} onConfirm={mock(() => {})} onCancel={mock(() => {})} />)
    expect(screen.getByText(/already has a paused goal \(7 of 50 turns used\)/)).toBeTruthy()
  })
})

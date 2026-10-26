/** Where a session plan stands, read with its task board and the goal that runs it. */
import { describe, expect, it } from 'bun:test'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import { nextTask, planStatus } from '@/lib/plan'

const PLAN: SessionPlan = {
  content: '# Ship it\n\n## Done when\n\nIt ships.',
  updated_at: '2026-10-24T00:00:00Z',
  revision: 2,
  approved_revision: 2,
  done_when: 'It ships.',
}

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'g1', session_id: 's1', objective: 'It ships.', status: 'active', pause_reason: null, detail: null,
    max_turns: 50, token_budget: null, turns_used: 2, tokens_used: 0, active_seconds: 0, rejected_claims: 0,
    created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', ended_at: null,
    ...overrides,
  }
}

const task = (task_id: string, status: TodoItem['status']): TodoItem => ({ task_id, content: task_id, status })

describe('planStatus', () => {
  it('reads review, draft, approved and changed since approval from the revisions', () => {
    expect(planStatus(PLAN, true)).toBe('review')
    expect(planStatus({ ...PLAN, approved_revision: null }, false)).toBe('draft')
    expect(planStatus(PLAN, false)).toBe('approved')
    expect(planStatus({ ...PLAN, approved_revision: 1 }, false)).toBe('changed')
  })

  it('is done once every task is finished, cancelled ones included', () => {
    expect(planStatus(PLAN, false, { todos: [task('a', 'completed'), task('b', 'cancelled')] })).toBe('done')
    expect(planStatus(PLAN, false, { todos: [task('a', 'completed'), task('b', 'pending')] })).toBe('approved')
    expect(planStatus(PLAN, false, { todos: [] })).toBe('approved')
  })

  it('follows the goal that runs it rather than the board', () => {
    const finished = [task('a', 'completed')]
    expect(planStatus(PLAN, false, { todos: finished, goal: goal() })).toBe('approved')
    expect(planStatus(PLAN, false, { todos: [task('a', 'pending')], goal: goal({ status: 'achieved' }) })).toBe('done')
  })

  it('ignores a goal with another objective', () => {
    const other = goal({ objective: 'Something else.', status: 'achieved' })
    expect(planStatus(PLAN, false, { todos: [task('a', 'pending')], goal: other })).toBe('approved')
  })
})

describe('nextTask', () => {
  it('picks the task in progress, else the first pending one', () => {
    expect(nextTask([task('a', 'pending'), task('b', 'in_progress')])?.task_id).toBe('b')
    expect(nextTask([task('a', 'completed'), task('b', 'pending'), task('c', 'pending')])?.task_id).toBe('b')
    expect(nextTask([task('a', 'completed')])).toBeNull()
  })
})

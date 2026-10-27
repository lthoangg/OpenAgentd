/**
 * TasksTabView — the task list with the plan's Done when as its last row, so a
 * finished list that is not yet a finished goal explains itself.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import { TasksTabView } from '@/components/WorkspacePanel/TasksTabView'

afterEach(cleanup)

const PLAN: SessionPlan = {
  content: '# Ship it\n\n## Done when\n\nAll tests pass.',
  updated_at: '2026-10-24T00:00:00Z',
  revision: 1,
  approved_revision: 1,
  done_when: 'All tests pass.',
}

const GOAL: SessionGoal = {
  id: 'g1', session_id: 's1', objective: 'All tests pass.', status: 'active', pause_reason: null, detail: null,
  max_turns: 50, token_budget: null, turns_used: 2, tokens_used: 0, active_seconds: 0, rejected_claims: 0,
  created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', ended_at: null,
}

const OPEN: TodoItem[] = [
  { task_id: 't1', content: 'Write it', status: 'completed' },
  { task_id: 't2', content: 'Test it', status: 'in_progress' },
]
const DONE: TodoItem[] = OPEN.map((t) => ({ ...t, status: 'completed' as const }))

const row = () => document.querySelector<HTMLElement>('[data-done-when]')

describe('TasksTabView — Done when', () => {
  it('ends the checklist with the finish line, after every task', () => {
    render(<TasksTabView todos={OPEN} sessionId="s1" plan={PLAN} goal={GOAL} onClearPlan={() => {}} />)
    expect(row()?.dataset.doneWhen).toBe('waiting')
    expect(row()?.textContent).toContain('All tests pass.')
    expect(row()?.textContent).toContain('Not checked yet')
    // A row of its own: the checklist still lists tasks only.
    expect(document.querySelectorAll('li')).toHaveLength(2)
  })

  it('says the check is next once every task is done', () => {
    render(<TasksTabView todos={DONE} sessionId="s1" plan={PLAN} goal={GOAL} onClearPlan={() => {}} />)
    expect(row()?.dataset.doneWhen).toBe('checking')
    expect(row()?.textContent).toContain('waiting for the completion check')
  })

  it('reads met once the goal is achieved, and open without a goal', () => {
    render(<TasksTabView todos={DONE} sessionId="s1" plan={PLAN} goal={{ ...GOAL, status: 'achieved' }} onClearPlan={() => {}} />)
    expect(row()?.dataset.doneWhen).toBe('met')
    cleanup()

    render(<TasksTabView todos={OPEN} sessionId="s1" plan={PLAN} onClearPlan={() => {}} />)
    expect(row()?.dataset.doneWhen).toBe('open')
  })

  it('is absent without a plan or a Done when', () => {
    render(<TasksTabView todos={OPEN} sessionId="s1" />)
    expect(row()).toBeNull()
    cleanup()

    render(<TasksTabView todos={OPEN} sessionId="s1" plan={{ ...PLAN, done_when: null }} onClearPlan={() => {}} />)
    expect(row()).toBeNull()
  })
})

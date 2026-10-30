import { describe, expect, it } from 'bun:test'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import type { GoalSessionState } from '@/lib/goal'
import { doneWhen, goalHeaderState, tasksFinished, workStatusLabel } from '@/lib/work'

const PLAN: SessionPlan = {
  content: '# Ship it\n\n## Done when\n\nIt ships.',
  updated_at: '2026-10-24T00:00:00Z',
  revision: 1,
  approved_revision: 1,
  done_when: 'It ships.',
}

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'g1', session_id: 's1', objective: 'It ships.', status: 'active', pause_reason: null, detail: null,
    max_turns: 50, token_budget: null, turns_used: 6, tokens_used: 0, active_seconds: 0, rejected_claims: 0,
    created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', ended_at: null,
    ...overrides,
  }
}

const todo = (id: string, status: TodoItem['status']): TodoItem => ({ task_id: id, content: `Task ${id}`, status })
const OPEN = [todo('1', 'completed'), todo('2', 'in_progress'), todo('3', 'pending')]
const DONE = [todo('1', 'completed'), todo('2', 'cancelled')]

const SESSION: GoalSessionState = { running: true, waitingForUser: false, planMode: false, queuedMessages: 0, subagentsRunning: 0 }

describe('tasksFinished', () => {
  it('needs at least one task, all of them completed or cancelled', () => {
    expect(tasksFinished([])).toBe(false)
    expect(tasksFinished(OPEN)).toBe(false)
    expect(tasksFinished(DONE)).toBe(true)
  })
})

describe('workStatusLabel', () => {
  it('folds the goal that runs the plan into one line', () => {
    expect(workStatusLabel(PLAN, false, { todos: OPEN, goal: goal() })).toBe('Approved · Running')
    expect(workStatusLabel(PLAN, false, { todos: DONE, goal: goal() })).toBe('All tasks done · checking')
    expect(workStatusLabel(PLAN, false, { todos: OPEN, goal: goal({ status: 'paused', pause_reason: 'turn_limit' }) })).toBe('Approved · Paused: turn limit')
    expect(workStatusLabel(PLAN, false, { todos: OPEN, goal: goal({ status: 'paused', pause_reason: 'blocked' }) })).toBe('Approved · Blocked')
    expect(workStatusLabel(PLAN, false, { todos: OPEN, goal: goal({ status: 'achieved' }) })).toBe('Done')
  })

  it("is the plan's own status without a goal on it", () => {
    expect(workStatusLabel(PLAN, false, { todos: OPEN })).toBe('Approved')
    expect(workStatusLabel(PLAN, false, { todos: DONE })).toBe('Done')
    expect(workStatusLabel(PLAN, true)).toBe('Awaiting review')
    expect(workStatusLabel({ ...PLAN, approved_revision: null }, false)).toBe('Draft')
    // A goal for some other objective does not run this plan.
    expect(workStatusLabel(PLAN, false, { todos: OPEN, goal: goal({ objective: 'Something else' }) })).toBe('Approved')
  })
})

describe('doneWhen', () => {
  it('is absent without a plan or a Done when', () => {
    expect(doneWhen(null)).toBeNull()
    expect(doneWhen({ ...PLAN, done_when: null })).toBeNull()
    expect(doneWhen({ ...PLAN, done_when: '  ' })).toBeNull()
  })

  it('says where the finish line stands', () => {
    expect(doneWhen(PLAN, { todos: OPEN })?.state).toBe('open')
    expect(doneWhen(PLAN, { todos: OPEN, goal: goal() })).toMatchObject({ state: 'waiting', text: 'It ships.' })
    expect(doneWhen(PLAN, { todos: DONE, goal: goal() })).toMatchObject({ state: 'checking', note: 'All tasks done · waiting for the completion check' })
    expect(doneWhen(PLAN, { todos: DONE, goal: goal({ status: 'paused', pause_reason: 'user' }) })?.note).toBe('All tasks done · the goal is paused')
    expect(doneWhen(PLAN, { todos: DONE, goal: goal({ status: 'achieved' }) })).toMatchObject({ state: 'met' })
  })
})

describe('goalHeaderState', () => {
  it('has nothing without a live goal', () => {
    expect(goalHeaderState(null, SESSION)).toBeNull()
    expect(goalHeaderState(goal({ status: 'achieved' }), SESSION)).toBeNull()
    expect(goalHeaderState(goal({ status: 'cleared' }), SESSION)).toBeNull()
  })

  it('names the working goal and its next task', () => {
    expect(goalHeaderState(goal(), SESSION, OPEN)).toEqual({ tone: 'active', text: 'Goal · Working · turn 7/50 · Next: Task 2' })
  })

  it('shows paused, waiting and blocked in their tones, with no next task', () => {
    expect(goalHeaderState(goal({ status: 'paused', pause_reason: 'stopped' }), SESSION, OPEN)).toEqual({ tone: 'paused', text: 'Goal · Paused: stopped' })
    expect(goalHeaderState(goal(), { ...SESSION, waitingForUser: true }, OPEN)?.tone).toBe('wait')
    expect(goalHeaderState(goal({ status: 'paused', pause_reason: 'blocked' }), SESSION)?.tone).toBe('blocked')
  })
})

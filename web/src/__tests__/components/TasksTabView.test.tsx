/**
 * TasksTabView — the task list with the plan's Done when as its last row, so a
 * finished list that is not yet a finished goal explains itself.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ContentBlock, SessionGoal, SessionPlan, TodoItem } from '@/api/types'
import { TasksTabView } from '@/components/WorkspacePanel/TasksTabView'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'

afterEach(() => {
  cleanup()
  useAgentStore.setState({ leadName: null, agentStreams: {} })
  useTranscriptFollowStore.setState({ showPrompt: null })
})

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

describe('TasksTabView — a task shows its turn', () => {
  it('brings the prompt of the turn that last changed the task into view, the live turn included', () => {
    const showPrompt = mock((..._args: unknown[]) => {})
    useTranscriptFollowStore.setState({ showPrompt })
    const todoCall = (id: string, actions: unknown[]): ContentBlock => ({ id, type: 'tool', content: '', toolName: 'todo', toolDone: true, toolArgs: JSON.stringify({ actions }) })
    useAgentStore.setState({
      leadName: 'lead',
      agentStreams: {
        lead: {
          blocks: [
            { id: 'p1', type: 'user', content: 'Ship it' },
            todoCall('c1', [{ action: 'create', content: 'Write it' }, { action: 'create', content: 'Test it' }]),
            { id: 'p2', type: 'user', content: 'Now test it' },
          ],
          currentBlocks: [todoCall('c2', [{ action: 'update', task_id: 't2', status: 'in_progress' }])],
          status: 'working', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
          model: null, lastError: null, currentText: '', currentThinking: '',
        },
      },
    })
    render(<TasksTabView todos={OPEN} sessionId="s1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Write it Show turn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Test it Show turn' }))

    expect(showPrompt.mock.calls).toEqual([['p1'], ['p2']])
  })
})

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

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TodosPopover } from '@/components/TodosPopover'
import type { SessionGoal, TodoItem } from '@/api/types'

afterEach(cleanup)

const TODOS: TodoItem[] = [
  { task_id: 'task_done', content: 'Completed task', status: 'completed' },
  { task_id: 'task_cancel', content: 'Cancelled task', status: 'cancelled' },
  { task_id: 'task_pending', content: 'Pending task', status: 'pending' },
  { task_id: 'task_active', content: 'Active task', status: 'in_progress' },
]

describe('TodosPopover — mobile edge-swipe exclusion', () => {
  it('marks the overlay data-swipe-ignore so useEdgeSwipe never reads a touch on it', () => {
    // Regression: the panel + backdrop are not tracked as a drawer by
    // useEdgeSwipe. Without this attribute an edge-zone touch on top of it
    // is read as a fresh "open" gesture for the drawer underneath.
    render(<TodosPopover open onOpenChange={() => {}} todos={[]} />)

    const overlay = document.querySelector('[role="presentation"]')
    expect(overlay).not.toBeNull()
    expect(overlay?.getAttribute('data-swipe-ignore')).not.toBeNull()
  })
})

describe('TodosPopover', () => {
  it('renders nothing while closed', () => {
    render(<TodosPopover open={false} onOpenChange={() => {}} todos={TODOS} />)
    expect(screen.queryByRole('dialog', { name: 'Tasks' })).toBeNull()
  })

  it('shows an empty-state message when there are no todos', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={[]} />)

    expect(screen.getByText('No tasks yet')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Task list' })).toBeNull()
  })

  it('shows the saved plan row even before there are tasks', () => {
    const plan = { content: '## Summary\nDo it.', updated_at: new Date().toISOString() }
    render(<TodosPopover open onOpenChange={() => {}} todos={[]} plan={plan} onClearPlan={() => {}} />)

    expect(screen.getByRole('button', { name: 'View plan' })).toBeTruthy()
    expect(screen.getByText('No tasks yet')).toBeTruthy()
  })

  it('has no plan row without a saved plan', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)
    expect(screen.queryByRole('button', { name: 'View plan' })).toBeNull()
  })

  it('closes itself and opens the Plan tab from the plan row', () => {
    const plan = { content: '## Summary\nDo it.', updated_at: new Date().toISOString() }
    const onOpenChange = mock(() => {})
    const onOpenPlan = mock(() => {})
    render(<TodosPopover open onOpenChange={onOpenChange} todos={[]} plan={plan} onClearPlan={() => {}} onOpenPlan={onOpenPlan} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
  })

  it('shows the goal above the plan, and opens the Goal tab from it', () => {
    const plan = { content: '# Ship it\n\n## Done when\n\nIt ships.', updated_at: new Date().toISOString(), revision: 1, approved_revision: 1, done_when: 'It ships.' }
    const goal: SessionGoal = {
      id: 'g1', session_id: 's1', objective: 'It ships.', status: 'active', pause_reason: null, detail: null,
      max_turns: 50, token_budget: null, turns_used: 2, tokens_used: 0, active_seconds: 0, rejected_claims: 0,
      created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', ended_at: null,
    }
    const onOpenChange = mock(() => {})
    const onOpenGoal = mock(() => {})
    render(
      <TodosPopover open onOpenChange={onOpenChange} todos={TODOS} goal={goal} plan={plan} onClearPlan={() => {}} onOpenGoal={onOpenGoal} />,
    )

    const summary = document.querySelector('[data-work-summary]')!
    expect(summary.querySelector('[data-goal-summary]')?.textContent).toContain('Goal')
    expect(summary.querySelector('[data-goal-summary]')?.textContent).toContain('It ships.')
    // The plan row reads Approved while its goal still runs, even with tasks left.
    expect(summary.querySelector('[data-plan-status]')?.getAttribute('data-plan-status')).toBe('approved')

    fireEvent.click(screen.getByRole('button', { name: 'Open goal' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenGoal).toHaveBeenCalledTimes(1)
  })

  it('renders a flat checklist sorted in_progress → pending → completed → cancelled', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)

    // Cancelled tasks have left the active set, so they count as finished.
    expect(screen.getByText('2/4 done')).toBeTruthy()
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Active task'),
      expect.stringContaining('Pending task'),
      expect.stringContaining('Completed task'),
      expect.stringContaining('Cancelled task'),
    ])
  })

  it('strikes through completed and cancelled rows, not pending or in_progress', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)

    expect(screen.getByText('Active task').className).not.toContain('line-through')
    expect(screen.getByText('Pending task').className).not.toContain('line-through')
    expect(screen.getByText('Completed task').className).toContain('line-through')
    expect(screen.getByText('Cancelled task').className).toContain('line-through')
  })

  it('fades in without the zoom-in animation', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={[]} />)

    const dialog = screen.getByRole('dialog', { name: 'Tasks' })
    expect(dialog.className).not.toContain('zoom-in-95')
    expect(dialog.className).toContain('fade-in-0')
  })

  it('closes from the backdrop', () => {
    const calls: boolean[] = []
    render(<TodosPopover open onOpenChange={(open) => calls.push(open)} todos={TODOS} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close tasks' }))
    expect(calls).toEqual([false])
  })

  it('keeps the progress counter at the 11px floor on desktop', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)
    const counter = screen.getByText('2/4 done')
    expect(counter.className).toContain('md:text-[11px]')
    expect(counter.className).not.toContain('text-[10px]')
  })
})

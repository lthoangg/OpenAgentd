/**
 * Tasks on a phone: the same list in a bottom sheet with two detents (medium,
 * large), opening at medium, closed by the sheet's own gestures. Every other
 * layout (a narrow mouse window, a tablet, the desktop) keeps the popover.
 *
 * happy-dom has no layout, so the sheet's content height and the viewport are
 * stubbed (see bottom-sheet.detents.test.tsx): 800px high, medium 400.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionGoal, TodoItem } from '@/api/types'

let phone = true
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => phone }))

import { TodosPopover } from '@/components/TodosPopover'

const TODOS: TodoItem[] = [
  { task_id: 'task_done', content: 'Completed task', status: 'completed' },
  { task_id: 'task_cancel', content: 'Cancelled task', status: 'cancelled' },
  { task_id: 'task_pending', content: 'Pending task', status: 'pending' },
  { task_id: 'task_active', content: 'Active task', status: 'in_progress' },
]

const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

beforeEach(() => {
  phone = true
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-sheet-content')) return 1000
      if (this.hasAttribute('data-sheet-handle')) return 24
      return 0
    },
  })
})

afterEach(() => {
  cleanup()
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight)
  if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
})

const sheet = () => screen.getByRole('dialog', { name: 'Tasks' })

describe('Tasks on a phone — a sheet with two detents', () => {
  it('opens in a bottom sheet called Tasks, at the medium detent', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)

    expect(sheet().hasAttribute('data-bottom-sheet')).toBe(true)
    expect(sheet().getAttribute('aria-modal')).toBe('true')
    expect(sheet().getAttribute('data-detent')).toBe('medium')
    expect(sheet().style.height).toBe('400px')
  })

  it('can be pulled up to large, the sheet\'s other detent', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)
    // The wheel steps a sheet up from medium, as a pull on the content does.
    fireEvent.wheel(sheet().querySelector('[data-sheet-body]')!, { deltaY: 60 })
    expect(sheet().getAttribute('data-detent')).toBe('large')
  })

  it('renders nothing while closed', () => {
    render(<TodosPopover open={false} onOpenChange={() => {}} todos={TODOS} />)
    expect(screen.queryByRole('dialog', { name: 'Tasks' })).toBeNull()
  })

  it('is not the popover: no panel under the header, no corner to grow from', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)
    expect(sheet().className).not.toContain('origin-top-right')
    expect(document.querySelector('[role="presentation"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close tasks' })).toBeNull()
  })

  it('shows the same checklist, sorted, with how far it has got', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)

    expect(within(sheet()).getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    expect(within(sheet()).getByText('2 of 4 done')).toBeTruthy()
    expect(within(sheet()).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Active task'),
      expect.stringContaining('Pending task'),
      expect.stringContaining('Completed task'),
      expect.stringContaining('Cancelled task'),
    ])
    expect(within(sheet()).getByRole('progressbar', { name: 'Task completion' })).toBeTruthy()
  })

  it('lets a long task wrap: a finger has no tooltip to read the rest in', () => {
    const long = 'Rewrite the migration so it backfills the new column in batches of a thousand rows'
    render(<TodosPopover open onOpenChange={() => {}} todos={[{ task_id: 't', content: long, status: 'pending' }]} />)
    const row = within(sheet()).getByText(long)
    expect(row.closest('p')?.className).toContain('break-words')
    expect(row.closest('p')?.className).not.toContain('truncate')
  })

  it('shows an empty list as the same placeholder', () => {
    render(<TodosPopover open onOpenChange={() => {}} todos={[]} />)
    expect(within(sheet()).getByText('No tasks yet').tagName).toBe('H2')
    expect(within(sheet()).queryByRole('list', { name: 'Tasks' })).toBeNull()
  })

  it('keeps the plan and goal rows above the list, each opening its tab and closing the sheet', () => {
    const plan = { content: '# Ship it\n\n## Done when\n\nIt ships.', updated_at: new Date().toISOString(), revision: 1, approved_revision: 1, done_when: 'It ships.' }
    const goal: SessionGoal = {
      id: 'g1', session_id: 's1', objective: 'It ships.', status: 'active', pause_reason: null, detail: null,
      max_turns: 50, token_budget: null, turns_used: 2, tokens_used: 0, active_seconds: 0, rejected_claims: 0,
      created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', ended_at: null,
    }
    const onOpenChange = mock(() => {})
    const onOpenPlan = mock(() => {})
    const onOpenGoal = mock(() => {})
    render(
      <TodosPopover open onOpenChange={onOpenChange} todos={TODOS} goal={goal} plan={plan} onClearPlan={() => {}} onOpenPlan={onOpenPlan} onOpenGoal={onOpenGoal} />,
    )
    // The criteria close the list, as in the popover.
    expect(sheet().querySelector('[data-done-when]')?.textContent).toContain('It ships.')

    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenPlan).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Open goal' }))
    expect(onOpenGoal).toHaveBeenCalledTimes(1)
  })
})

describe('Tasks on a phone — closing', () => {
  it('closes from the backdrop', () => {
    const calls: boolean[] = []
    render(<TodosPopover open onOpenChange={(open) => calls.push(open)} todos={TODOS} />)

    fireEvent.click(document.querySelector('[data-sheet-scrim]')!.parentElement!)
    expect(calls).toEqual([false])
  })

  it('closes from Escape', () => {
    const calls: boolean[] = []
    render(<TodosPopover open onOpenChange={(open) => calls.push(open)} todos={TODOS} />)

    fireEvent.keyDown(sheet(), { key: 'Escape' })
    expect(calls).toEqual([false])
  })

  it('closes from Done, a plain way out for whoever does not drag', () => {
    const calls: boolean[] = []
    render(<TodosPopover open onOpenChange={(open) => calls.push(open)} todos={TODOS} />)

    fireEvent.click(within(sheet()).getByRole('button', { name: 'Done' }))
    expect(calls).toEqual([false])
    // Not a ×: the rulebook gives a surface one, top right, and a sheet has the handle.
    expect(within(sheet()).queryByRole('button', { name: /^Close/ })).toBeNull()
  })
})

describe('Tasks off a phone — the popover', () => {
  it('is the panel under the header on a narrow mouse window, a tablet and the desktop', () => {
    phone = false
    render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)

    expect(sheet().hasAttribute('data-bottom-sheet')).toBe(false)
    expect(sheet().className).toContain('origin-top-right')
    expect(screen.getByRole('button', { name: 'Close tasks' })).toBeTruthy()
    expect(screen.getByText('2/4 done')).toBeTruthy()
  })

  it('turns into the sheet when the same view becomes a phone', () => {
    phone = false
    const view = render(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)
    expect(sheet().hasAttribute('data-bottom-sheet')).toBe(false)

    phone = true
    view.rerender(<TodosPopover open onOpenChange={() => {}} todos={TODOS} />)
    expect(sheet().hasAttribute('data-bottom-sheet')).toBe(true)
  })
})

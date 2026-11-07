/**
 * A task row in the desktop Tasks tab brings the turn where the task last
 * changed into view. Without a turn (an older page) or a handler (the phone
 * popover) a row stays plain text.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TodoItem } from '@/api/types'
import { TaskChecklist } from '@/components/TaskChecklist'

afterEach(cleanup)

const TODOS: TodoItem[] = [
  { task_id: 'task_1', content: 'Read the handler', status: 'completed' },
  { task_id: 'task_2', content: 'Write tests', status: 'in_progress' },
]

describe('TaskChecklist turns', () => {
  it('shows the turn of a task that has one', () => {
    const onShowTurn = mock((..._args: unknown[]) => {})
    render(<TaskChecklist todos={TODOS} overflow="wrap" turns={new Map([['task_2', 'p3']])} onShowTurn={onShowTurn} />)

    fireEvent.click(screen.getByRole('button', { name: 'Write tests Show turn' }))

    expect(onShowTurn).toHaveBeenCalledWith('p3')
    expect(screen.queryByRole('button', { name: /Read the handler/ })).toBeNull()
  })

  it('keeps every row plain without a handler', () => {
    render(<TaskChecklist todos={TODOS} overflow="wrap" turns={new Map([['task_2', 'p3']])} />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

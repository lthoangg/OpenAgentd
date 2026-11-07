import { describe, expect, it } from 'bun:test'
import type { ContentBlock, TodoItem } from '@/api/types'
import { taskTurnPrompts } from '@/lib/task-turns'

const prompt = (id: string): ContentBlock => ({ id, type: 'user', content: id })
const todo = (id: string, actions: unknown[], name = 'todo'): ContentBlock => ({
  id, type: 'tool', content: '', toolName: name, toolDone: true, toolArgs: JSON.stringify({ actions }),
})
const task = (task_id: string, content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({ task_id, content, status })

describe('taskTurnPrompts', () => {
  it('maps a task to the prompt of the turn that created it, by its text', () => {
    const blocks = [prompt('p1'), todo('t1', [{ action: 'create', content: 'Read the handler' }, { action: 'create', content: 'Write tests' }])]
    const turns = taskTurnPrompts(blocks, [task('task_1', 'Read the handler'), task('task_2', 'Write tests')])

    expect(Object.fromEntries(turns)).toEqual({ task_1: 'p1', task_2: 'p1' })
  })

  it('moves a task to the latest turn that updated it, by its id', () => {
    const blocks = [
      prompt('p1'), todo('t1', [{ action: 'create', content: 'Read the handler' }, { action: 'create', content: 'Write tests' }]),
      prompt('p2'), todo('t2', [{ action: 'update', task_id: 'task_2', status: 'in_progress' }]),
      prompt('p3'), todo('t3', [{ action: 'update', task_id: 'task_2', status: 'completed' }]),
    ]
    const turns = taskTurnPrompts(blocks, [task('task_1', 'Read the handler'), task('task_2', 'Write tests', 'completed')])

    expect(Object.fromEntries(turns)).toEqual({ task_1: 'p1', task_2: 'p3' })
  })

  it('reads a single top-level action and the former tool name', () => {
    const single: ContentBlock = { id: 't1', type: 'tool', content: '', toolName: 'todo_manage', toolArgs: JSON.stringify({ action: 'update', task_id: 'task_1', status: 'completed' }) }
    expect(taskTurnPrompts([prompt('p1'), single], [task('task_1', 'x')]).get('task_1')).toBe('p1')
  })

  it('counts only your prompts as turns, not a message another agent sent', () => {
    const inbox: ContentBlock = { id: 'in1', type: 'user', content: 'report', extra: { from_agent: 'explorer#1' } }
    const blocks = [prompt('p1'), inbox, todo('t1', [{ action: 'update', task_id: 'task_1', status: 'completed' }])]

    expect(taskTurnPrompts(blocks, [task('task_1', 'x')]).get('task_1')).toBe('p1')
  })

  it('leaves out tasks whose turn is not loaded, and calls before any prompt', () => {
    const blocks = [todo('t0', [{ action: 'update', task_id: 'task_1', status: 'completed' }]), prompt('p1'), todo('t1', [{ action: 'read' }])]

    expect(taskTurnPrompts(blocks, [task('task_1', 'x'), task('task_2', 'y')]).size).toBe(0)
  })

  it('skips arguments it cannot read', () => {
    const broken: ContentBlock = { id: 't1', type: 'tool', content: '', toolName: 'todo', toolArgs: '{"actions": [' }
    expect(taskTurnPrompts([prompt('p1'), broken], [task('task_1', 'x')]).size).toBe(0)
  })
})

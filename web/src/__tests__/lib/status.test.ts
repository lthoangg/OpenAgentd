/**
 * One status vocabulary (DESIGN.md → Status): the same state reads with the
 * same word and tone on every surface, and colour is kept for what needs a
 * look: Needs you in orange, Failed in red, healthy (Ready, Connected) in green.
 */
import { describe, expect, test } from 'bun:test'

import { STATUS, type StatusView } from '@/lib/status'
import { subagentStatusView } from '@/components/ToolCall/subagentStatus'
import { taskState } from '@/components/SchedulerPanel/utils'

describe('STATUS', () => {
  test('keeps green for healthy states only', () => {
    const green = Object.entries(STATUS).filter(([, s]) => s.tone === 'success').map(([k]) => k).sort()
    expect(green).toEqual(['connected', 'ready'])
  })

  test('reads a finished state as quiet text, not a colour', () => {
    expect(STATUS.done.tone).toBe('neutral')
    expect(STATUS.stopped.tone).toBe('neutral')
    expect(STATUS.paused.tone).toBe('neutral')
    expect(STATUS.inUse.tone).toBe('neutral')
  })

  test('marks a live state with a spinner', () => {
    expect(STATUS.running.spinner).toBe(true)
    expect(STATUS.starting.spinner).toBe(true)
    expect((STATUS.done as StatusView).spinner).toBeUndefined()
  })

  test('writes every label in sentence case', () => {
    for (const { label } of Object.values(STATUS)) expect(label[0]).toBe(label[0].toUpperCase())
  })
})

describe('surfaces share the vocabulary', () => {
  test('a finished subagent and a finished scheduled task read the same', () => {
    const subagent = subagentStatusView('completed')
    const task = taskState({ status: 'completed', enabled: true, next_fire_at: null })
    expect({ label: subagent?.label, tone: subagent?.tone }).toEqual({ label: 'Done', tone: 'neutral' })
    expect({ label: task.label, tone: task.tone }).toEqual({ label: 'Done', tone: 'neutral' })
  })

  test('a running subagent and a running scheduled task both spin', () => {
    expect(subagentStatusView('working')).toMatchObject({ label: 'Running', spinner: true })
    expect(taskState({ status: 'running', enabled: true, next_fire_at: null })).toMatchObject({ label: 'Running', spinner: true })
  })
})

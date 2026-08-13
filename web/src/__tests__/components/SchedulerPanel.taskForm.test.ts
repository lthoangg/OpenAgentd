import { describe, expect, it } from 'bun:test'
import {
  createTaskDefaults,
  editTaskDefaults,
  toUpdatePayload,
  toCreatePayload,
  validateTaskValues,
} from '@/components/SchedulerPanel/taskForm'

describe('scheduler task form helpers', () => {
  const localTz = 'America/New_York'

  it('creates context-aware defaults', () => {
    expect(createTaskDefaults('normal', '/ignored', localTz)).toMatchObject({
      title: '', mode: 'normal', workspace: null, schedule_type: 'every',
      every_seconds: 3600, timezone: localTz, prompt: '', sessionType: 'new',
      customSessionId: '', max_runs: null, enabled: true,
    })
    expect(createTaskDefaults('coding', '/repo/app', localTz).workspace).toBe('/repo/app')
  })

  it('reports required and constrained values by field', () => {
    const errors = validateTaskValues({
      ...createTaskDefaults('normal', null, localTz),
      title: '---', prompt: ' ', schedule_type: 'every', every_seconds: 0,
      max_runs: -1, sessionType: 'custom', customSessionId: 'not-a-uuid',
    })
    expect(errors).toMatchObject({
      title: expect.any(String), prompt: expect.any(String), every_seconds: expect.any(String),
      max_runs: expect.any(String), customSessionId: expect.any(String),
    })
  })

  it('serializes exclusive at, every, and cron create payloads', () => {
    const base = { ...createTaskDefaults('normal', null, localTz), title: ' Daily Report ', prompt: '  Send report  ' }
    expect(toCreatePayload({ ...base, schedule_type: 'at', at_datetime: '2026-11-01T09:30', every_seconds: 99, cron_expression: 'ignored' }, localTz)).toEqual({
      name: 'Daily Report', mode: 'normal', workspace: null, schedule_type: 'at', timezone: localTz,
      prompt: 'Send report', session_id: null, max_runs: null, enabled: true,
      at_datetime: '2026-11-01T09:30:00-05:00',
    })
    expect(toCreatePayload({ ...base, schedule_type: 'every', every_seconds: 120, at_datetime: 'ignored', cron_expression: 'ignored' }, localTz)).toEqual({
      name: 'Daily Report', mode: 'normal', workspace: null, schedule_type: 'every', timezone: localTz,
      prompt: 'Send report', session_id: null, max_runs: null, enabled: true, every_seconds: 120,
    })
    expect(toCreatePayload({ ...base, schedule_type: 'cron', cron_expression: ' 0 9 * * * ', every_seconds: 99 }, localTz)).toEqual({
      name: 'Daily Report', mode: 'normal', workspace: null, schedule_type: 'cron', timezone: localTz,
      prompt: 'Send report', session_id: null, max_runs: null, enabled: true, cron_expression: ' 0 9 * * * ',
    })
  })

  it('maps session target variants to API values', () => {
    const base = { ...createTaskDefaults('normal', null, localTz), title: 'Task', prompt: 'Prompt' }
    expect(toCreatePayload({ ...base, sessionType: 'auto' }, localTz).session_id).toBe('auto')
    expect(toCreatePayload({ ...base, sessionType: 'current' }, localTz, 'current-id').session_id).toBe('current-id')
    expect(toCreatePayload({ ...base, sessionType: 'custom', customSessionId: ' 123e4567-e89b-12d3-a456-426614174000 ' }, localTz).session_id).toBe('123e4567-e89b-12d3-a456-426614174000')
  })

  it('hydrates edit values and serializes an exclusive update payload', () => {
    const values = editTaskDefaults({
      name: 'Existing', mode: 'coding', workspace: '/repo', schedule_type: 'at',
      at_datetime: '2026-11-01T14:30:00Z', every_seconds: null, cron_expression: null,
      timezone: 'America/New_York', prompt: 'Prompt', session_id: 'auto', max_runs: 2, enabled: false,
    }, 'current-id')
    expect(values).toMatchObject({ title: 'Existing', at_datetime: '2026-11-01T09:30', sessionType: 'auto' })
    expect(toUpdatePayload(values, localTz, 'current-id')).toEqual({
      mode: 'coding', workspace: '/repo', schedule_type: 'at', timezone: 'America/New_York', prompt: 'Prompt',
      session_id: 'auto', max_runs: 2, enabled: false, at_datetime: '2026-11-01T09:30:00-05:00',
    })
  })
})

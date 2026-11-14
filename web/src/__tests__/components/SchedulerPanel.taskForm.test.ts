import { describe, expect, it } from 'bun:test'
import {
  createTaskDefaults,
  editTaskDefaults,
  titleFromPrompt,
  toUpdatePayload,
  toCreatePayload,
  validateTaskValues,
} from '@/components/SchedulerPanel/taskForm'

describe('scheduler task form helpers', () => {
  const localTz = 'America/New_York'

  it('starts a new task on every day at 09:00, in a new session each time', () => {
    expect(createTaskDefaults('/repo/app', localTz)).toEqual({
      title: '', workspace: '/repo/app', when: 'daily', time: '09:00', weekday: 1,
      at_datetime: '', every_seconds: 3600, cron_expression: '', timezone: localTz, prompt: '',
      sessionType: 'new', customSessionId: '', max_runs: null, enabled: true,
    })
  })

  it('reports required and constrained values by field', () => {
    const errors = validateTaskValues({
      ...createTaskDefaults('', localTz),
      title: '---', prompt: ' ', when: 'interval', every_seconds: 0,
      max_runs: -1, sessionType: 'custom', customSessionId: 'not-a-uuid',
    })
    expect(errors).toMatchObject({
      title: expect.any(String), workspace: expect.any(String), prompt: expect.any(String),
      every_seconds: expect.any(String), max_runs: expect.any(String), customSessionId: expect.any(String),
    })
  })

  it('does not ask for a name: an empty one is written from the prompt', () => {
    const values = { ...createTaskDefaults('/repo/app', localTz), prompt: 'Summarize what changed since yesterday.' }
    expect(validateTaskValues(values)).toEqual({})
    expect(toCreatePayload(values, localTz).name).toBe('Summarize what changed since yesterday')
  })

  it('asks for a time on the daily and weekly choices, and for a date on a one-time task', () => {
    const base = { ...createTaskDefaults('/repo/app', localTz), prompt: 'Go' }
    expect(validateTaskValues({ ...base, when: 'weekly', time: '' })).toEqual({ time: expect.any(String) })
    expect(validateTaskValues({ ...base, when: 'once', at_datetime: '' })).toEqual({ at_datetime: expect.any(String) })
    expect(validateTaskValues({ ...base, when: 'custom', cron_expression: 'nope' })).toEqual({ cron_expression: expect.any(String) })
    // A field the chosen "When?" does not show is not checked.
    expect(validateTaskValues({ ...base, when: 'interval', time: '', cron_expression: 'nope' })).toEqual({})
  })

  it('writes each "When?" choice as one of the three schedule types', () => {
    const base = { ...createTaskDefaults('/repo/app', localTz), title: ' Daily Report ', prompt: '  Send report  ' }
    const common = {
      name: 'Daily Report', workspace: '/repo/app', timezone: localTz,
      prompt: 'Send report', session_id: null, max_runs: null, enabled: true,
    }
    expect(toCreatePayload({ ...base, when: 'daily', time: '09:00' }, localTz)).toEqual({ ...common, schedule_type: 'cron', cron_expression: '0 9 * * *' })
    expect(toCreatePayload({ ...base, when: 'weekdays', time: '18:30' }, localTz)).toEqual({ ...common, schedule_type: 'cron', cron_expression: '30 18 * * 1-5' })
    expect(toCreatePayload({ ...base, when: 'weekly', time: '07:05', weekday: 5 }, localTz)).toEqual({ ...common, schedule_type: 'cron', cron_expression: '5 7 * * 5' })
    expect(toCreatePayload({ ...base, when: 'interval', every_seconds: 120, at_datetime: 'ignored', cron_expression: 'ignored' }, localTz)).toEqual({ ...common, schedule_type: 'every', every_seconds: 120 })
    expect(toCreatePayload({ ...base, when: 'once', at_datetime: '2026-11-01T09:30', every_seconds: 99, cron_expression: 'ignored' }, localTz)).toEqual({ ...common, schedule_type: 'at', at_datetime: '2026-11-01T09:30:00-05:00' })
    expect(toCreatePayload({ ...base, when: 'custom', cron_expression: ' 0 9 1 * * ', every_seconds: 99 }, localTz)).toEqual({ ...common, schedule_type: 'cron', cron_expression: ' 0 9 1 * * ' })
  })

  it('maps session target variants to API values', () => {
    const base = { ...createTaskDefaults('/repo/app', localTz), title: 'Task', prompt: 'Prompt' }
    expect(toCreatePayload({ ...base, sessionType: 'auto' }, localTz).session_id).toBe('auto')
    expect(toCreatePayload({ ...base, sessionType: 'current' }, localTz, 'current-id').session_id).toBe('current-id')
    expect(toCreatePayload({ ...base, sessionType: 'custom', customSessionId: ' 123e4567-e89b-12d3-a456-426614174000 ' }, localTz).session_id).toBe('123e4567-e89b-12d3-a456-426614174000')
  })

  it('hydrates edit values and serializes an exclusive update payload', () => {
    const values = editTaskDefaults({
      name: 'Existing', workspace: '/repo', schedule_type: 'at',
      at_datetime: '2026-11-01T14:30:00Z', every_seconds: null, cron_expression: null,
      timezone: 'America/New_York', prompt: 'Prompt', session_id: 'auto', max_runs: 2, enabled: false,
    }, 'current-id')
    expect(values).toMatchObject({ title: 'Existing', when: 'once', at_datetime: '2026-11-01T09:30', sessionType: 'auto' })
    expect(toUpdatePayload(values, localTz, 'current-id')).toEqual({
      workspace: '/repo', schedule_type: 'at', timezone: 'America/New_York', prompt: 'Prompt',
      session_id: 'auto', max_runs: 2, enabled: false, at_datetime: '2026-11-01T09:30:00-05:00',
    })
  })

  it('reads a saved cron expression back as the "When?" choice that wrote it', () => {
    const task = {
      name: 'T', workspace: '/repo', schedule_type: 'cron' as const, at_datetime: null, every_seconds: null,
      timezone: 'UTC', prompt: 'P', session_id: null, max_runs: null, enabled: true,
    }
    const read = (cron_expression: string) => editTaskDefaults({ ...task, cron_expression }, null)
    expect(read('0 9 * * *')).toMatchObject({ when: 'daily', time: '09:00' })
    expect(read('30 18 * * 1-5')).toMatchObject({ when: 'weekdays', time: '18:30' })
    expect(read('5 7 * * 5')).toMatchObject({ when: 'weekly', time: '07:05', weekday: 5 })
    expect(read('0 9 * * 7')).toMatchObject({ when: 'weekly', weekday: 0 })
    // Anything else stays a cron expression, untouched.
    expect(read('*/15 * * * *')).toMatchObject({ when: 'custom', cron_expression: '*/15 * * * *' })
    expect(read('0 9 1 * *')).toMatchObject({ when: 'custom' })
    expect(read('0 25 * * *')).toMatchObject({ when: 'custom' })
    expect(editTaskDefaults({ ...task, schedule_type: 'every', every_seconds: 600, cron_expression: null }, null)).toMatchObject({ when: 'interval', every_seconds: 600 })
  })

  describe('titleFromPrompt', () => {
    it('takes the first line, without its closing punctuation', () => {
      expect(titleFromPrompt('Check the build.\nThen report.')).toBe('Check the build')
    })

    it('cuts a long prompt at a word, within 60 characters', () => {
      const title = titleFromPrompt('Summarize what changed in this folder since yesterday and list every file that was touched')
      expect(title).toBe('Summarize what changed in this folder since yesterday and')
      expect(title.length).toBeLessThanOrEqual(60)
    })

    it('falls back to a plain name when the prompt has no letter or number to name it by', () => {
      expect(titleFromPrompt('日本語')).toBe('Scheduled task')
    })

    it('numbers a name another task already has', () => {
      expect(titleFromPrompt('Check the build', ['check-the-build'])).toBe('Check the build 2')
      expect(titleFromPrompt('Check the build', ['check-the-build', 'check-the-build-2'])).toBe('Check the build 3')
    })
  })
})

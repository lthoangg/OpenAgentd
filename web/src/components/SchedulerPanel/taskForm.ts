import type { ScheduledTaskCreate, ScheduledTaskResponse } from '@/api/types'
import { isoToWallClock, wallClockToISO } from '@/utils/format'
import { isValidCron } from './cron'
import { slugify } from './utils'

export type SessionType = 'new' | 'auto' | 'current' | 'custom'

/**
 * The form's "When?" choices. Each is written as one of the three schedule
 * types the scheduler stores: the daily and weekly ones as a cron expression,
 * ``interval`` as ``every`` and ``once`` as ``at``.
 */
export type When = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'once' | 'custom'

export interface TaskFormValues {
  /** Optional on create: an empty name is written from the prompt. */
  title: string
  workspace: string
  when: When
  /** "HH:mm", for the daily and weekly choices. */
  time: string
  /** Day of the week as cron counts it (0 = Sunday), for ``weekly``. */
  weekday: number
  at_datetime: string
  every_seconds: number
  cron_expression: string
  timezone: string
  prompt: string
  sessionType: SessionType
  customSessionId: string
  max_runs: number | null
  enabled: boolean
}
export type TaskFormErrors = Partial<Record<keyof TaskFormValues, string>>

const TIMED: readonly When[] = ['daily', 'weekdays', 'weekly']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const pad = (n: number) => String(n).padStart(2, '0')

export function createTaskDefaults(contextWorkspace: string | null, localTz: string): TaskFormValues {
  return {
    title: '', workspace: contextWorkspace ?? '', when: 'daily', time: '09:00', weekday: 1,
    at_datetime: '', every_seconds: 3600, cron_expression: '', timezone: localTz, prompt: '',
    sessionType: 'new', customSessionId: '', max_runs: null, enabled: true,
  }
}

/** The "When?" choice a saved cron expression was written by, or ``custom``. */
function readCron(expr: string): Pick<TaskFormValues, 'when' | 'time' | 'weekday'> | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/.exec(expr.trim())
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return null
  const time = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`
  if (m[3] === '*') return { when: 'daily', time, weekday: 1 }
  if (m[3] === '1-5') return { when: 'weekdays', time, weekday: 1 }
  return { when: 'weekly', time, weekday: Number(m[3]) % 7 }
}

export function editTaskDefaults(task: Pick<ScheduledTaskResponse, 'name' | 'workspace' | 'schedule_type' | 'at_datetime' | 'every_seconds' | 'cron_expression' | 'timezone' | 'prompt' | 'session_id' | 'max_runs' | 'enabled'>, currentSessionId: string | null): TaskFormValues {
  const sessionType: SessionType = !task.session_id ? 'new' : task.session_id === 'auto' ? 'auto' : task.session_id === currentSessionId ? 'current' : 'custom'
  const schedule = task.schedule_type === 'every'
    ? { when: 'interval' as const, time: '09:00', weekday: 1 }
    : task.schedule_type === 'at'
      ? { when: 'once' as const, time: '09:00', weekday: 1 }
      : readCron(task.cron_expression ?? '') ?? { when: 'custom' as const, time: '09:00', weekday: 1 }
  return {
    title: task.name, workspace: task.workspace, ...schedule,
    at_datetime: task.at_datetime ? isoToWallClock(task.at_datetime, task.timezone) : '',
    every_seconds: task.every_seconds ?? 3600, cron_expression: task.cron_expression ?? '', timezone: task.timezone,
    prompt: task.prompt, sessionType, customSessionId: sessionType === 'custom' ? task.session_id ?? '' : '',
    max_runs: task.max_runs, enabled: task.enabled,
  }
}

export function validateTaskValues(values: TaskFormValues): TaskFormErrors {
  const errors: TaskFormErrors = {}
  if (values.title.trim() && !slugify(values.title)) errors.title = 'The name needs at least one letter or number.'
  if (!values.workspace.trim()) errors.workspace = 'Choose a workspace.'
  if (!values.prompt.trim()) errors.prompt = 'Say what the task should do.'
  if (TIMED.includes(values.when) && !/^\d{2}:\d{2}$/.test(values.time)) errors.time = 'Choose a time.'
  if (values.when === 'once' && !values.at_datetime) errors.at_datetime = 'Choose a date and time.'
  if (values.when === 'interval' && (!Number.isInteger(values.every_seconds) || values.every_seconds <= 0)) errors.every_seconds = 'Enter a whole number above zero.'
  if (values.when === 'custom' && !values.cron_expression.trim()) errors.cron_expression = 'Enter a cron expression.'
  else if (values.when === 'custom' && !isValidCron(values.cron_expression)) errors.cron_expression = "This isn't a valid cron expression. Use five fields: minute, hour, day of month, month, day of week."
  if (values.max_runs !== null && (!Number.isInteger(values.max_runs) || values.max_runs <= 0)) errors.max_runs = 'Enter a whole number above zero, or leave it empty.'
  if (values.sessionType === 'custom') {
    if (!values.customSessionId.trim()) errors.customSessionId = 'Enter a session ID.'
    else if (!UUID.test(values.customSessionId.trim())) errors.customSessionId = "This isn't a session ID. One looks like 123e4567-e89b-12d3-a456-426614174000."
  }
  return errors
}

/**
 * A task's name when none was typed: the prompt's first line, cut at a word
 * within 60 characters. Task names are unique, so a name whose slug is in
 * ``takenSlugs`` gets the first free number after it.
 */
export function titleFromPrompt(prompt: string, takenSlugs: readonly string[] = []): string {
  const line = prompt.trim().split('\n', 1)[0].trim()
  let base = line
  if (base.length > 60) {
    base = base.slice(0, 61)
    base = base.slice(0, Math.max(base.lastIndexOf(' '), 1)).trim()
    if (base.length > 60) base = base.slice(0, 60)
  }
  base = base.replace(/[\s.,;:!?]+$/, '')
  if (!slugify(base)) base = 'Scheduled task'
  let title = base
  for (let n = 2; takenSlugs.includes(slugify(title)); n += 1) title = `${base} ${n}`
  return title
}

/** The schedule type and its one field for the chosen "When?". */
function schedulePayload(values: TaskFormValues, timezone: string): Pick<ScheduledTaskCreate, 'schedule_type' | 'at_datetime' | 'every_seconds' | 'cron_expression'> {
  if (values.when === 'interval') return { schedule_type: 'every', every_seconds: values.every_seconds }
  if (values.when === 'once') return { schedule_type: 'at', at_datetime: wallClockToISO(values.at_datetime, timezone) }
  if (values.when === 'custom') return { schedule_type: 'cron', cron_expression: values.cron_expression }
  return { schedule_type: 'cron', cron_expression: timedCron(values) }
}

/** "0 9 * * 1-5" for the daily and weekly choices. */
export function timedCron(values: Pick<TaskFormValues, 'when' | 'time' | 'weekday'>): string {
  const [hour, minute] = values.time.split(':').map(Number)
  const days = values.when === 'weekdays' ? '1-5' : values.when === 'weekly' ? String(values.weekday) : '*'
  return `${minute || 0} ${hour || 0} * * ${days}`
}

export function toCreatePayload(values: TaskFormValues, localTz: string, currentSessionId: string | null = null, takenSlugs: readonly string[] = []): ScheduledTaskCreate {
  const timezone = values.timezone || localTz
  const session_id = values.sessionType === 'new' ? null : values.sessionType === 'auto' ? 'auto' : values.sessionType === 'current' ? currentSessionId : values.customSessionId.trim() || null
  return {
    name: values.title.trim() || titleFromPrompt(values.prompt, takenSlugs),
    workspace: values.workspace.trim(), timezone, prompt: values.prompt.trim(), session_id,
    max_runs: values.max_runs, enabled: values.enabled, ...schedulePayload(values, timezone),
  }
}

export function toUpdatePayload(values: TaskFormValues, localTz: string, currentSessionId: string | null = null): Partial<ScheduledTaskCreate> {
  const { name: _name, ...payload } = toCreatePayload(values, localTz, currentSessionId)
  return payload
}

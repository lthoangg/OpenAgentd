import type { ScheduledTaskCreate, ScheduledTaskMode, ScheduledTaskResponse } from '@/api/types'
import { isoToWallClock, wallClockToISO } from '@/utils/format'
import { slugify } from './utils'

export type SessionType = 'new' | 'auto' | 'current' | 'custom'
export interface TaskFormValues { title: string; mode: ScheduledTaskMode; workspace: string | null; schedule_type: ScheduledTaskCreate['schedule_type']; at_datetime: string; every_seconds: number; cron_expression: string; timezone: string; prompt: string; sessionType: SessionType; customSessionId: string; max_runs: number | null; enabled: boolean }
export type TaskFormErrors = Partial<Record<keyof TaskFormValues, string>>

export function createTaskDefaults(contextMode: ScheduledTaskMode, contextWorkspace: string | null, localTz: string): TaskFormValues {
  return { title: '', mode: contextMode, workspace: contextMode === 'coding' ? contextWorkspace : null, schedule_type: 'every', at_datetime: '', every_seconds: 3600, cron_expression: '', timezone: localTz, prompt: '', sessionType: 'new', customSessionId: '', max_runs: null, enabled: true }
}

export function editTaskDefaults(task: Pick<ScheduledTaskResponse, 'name' | 'mode' | 'workspace' | 'schedule_type' | 'at_datetime' | 'every_seconds' | 'cron_expression' | 'timezone' | 'prompt' | 'session_id' | 'max_runs' | 'enabled'>, currentSessionId: string | null): TaskFormValues {
  const sessionType: SessionType = !task.session_id ? 'new' : task.session_id === 'auto' ? 'auto' : task.session_id === currentSessionId ? 'current' : 'custom'
  return { title: task.name, mode: task.mode, workspace: task.workspace, schedule_type: task.schedule_type, at_datetime: task.at_datetime ? isoToWallClock(task.at_datetime, task.timezone) : '', every_seconds: task.every_seconds ?? 3600, cron_expression: task.cron_expression ?? '', timezone: task.timezone, prompt: task.prompt, sessionType, customSessionId: sessionType === 'custom' ? task.session_id ?? '' : '', max_runs: task.max_runs, enabled: task.enabled }
}

export function validateTaskValues(values: TaskFormValues, requireTitle = true): TaskFormErrors {
  const errors: TaskFormErrors = {}
  if (requireTitle && !values.title.trim()) errors.title = 'Task title is required'
  else if (requireTitle && !slugify(values.title)) errors.title = 'Task title must contain at least one letter or number'
  if (values.mode === 'coding' && !values.workspace?.trim()) errors.workspace = 'Workspace is required for coding mode'
  if (!values.prompt.trim()) errors.prompt = 'Prompt is required'
  if (values.schedule_type === 'at' && !values.at_datetime) errors.at_datetime = 'Date/time is required for "at" schedule'
  if (values.schedule_type === 'every' && (!Number.isInteger(values.every_seconds) || values.every_seconds <= 0)) errors.every_seconds = 'Interval must be a positive integer'
  if (values.schedule_type === 'cron' && !values.cron_expression.trim()) errors.cron_expression = 'Cron expression is required'
  if (values.max_runs !== null && (!Number.isInteger(values.max_runs) || values.max_runs <= 0)) errors.max_runs = 'Max runs must be a positive integer'
  if (values.sessionType === 'custom') {
    if (!values.customSessionId.trim()) errors.customSessionId = 'Session UUID is required'
    else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.customSessionId.trim())) errors.customSessionId = 'Please enter a valid UUID (e.g. 123e4567-e89b-12d3-a456-426614174000)'
  }
  return errors
}

export function toCreatePayload(values: TaskFormValues, localTz: string, currentSessionId: string | null = null): ScheduledTaskCreate {
  const timezone = values.timezone || localTz
  return { name: values.title.trim(), mode: values.mode, workspace: values.mode === 'coding' ? values.workspace!.trim() : null, schedule_type: values.schedule_type, timezone, prompt: values.prompt.trim(), session_id: values.sessionType === 'new' ? null : values.sessionType === 'auto' ? 'auto' : values.sessionType === 'current' ? currentSessionId : values.customSessionId.trim() || null, max_runs: values.max_runs, enabled: values.enabled, ...(values.schedule_type === 'at' ? { at_datetime: wallClockToISO(values.at_datetime, timezone) } : {}), ...(values.schedule_type === 'every' ? { every_seconds: values.every_seconds } : {}), ...(values.schedule_type === 'cron' ? { cron_expression: values.cron_expression } : {}) }
}

export function toUpdatePayload(values: TaskFormValues, localTz: string, currentSessionId: string | null = null): Partial<ScheduledTaskCreate> {
  const { name: _name, ...payload } = toCreatePayload(values, localTz, currentSessionId)
  return payload
}

/**
 * OpenAgentd API client — scheduler group: /scheduler/tasks.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'
import type {
  ScheduledTaskResponse,
  ScheduledTaskCreate,
  ScheduledTaskListResponse,
} from '../types'

export async function listScheduledTasks(): Promise<ScheduledTaskListResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks`)
  if (!res.ok) await parseDetailOrThrow(res, 'listScheduledTasks')
  return res.json()
}

export async function createScheduledTask(body: ScheduledTaskCreate): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /scheduler/tasks')
  return res.json()
}

export async function getScheduledTask(id: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(id)}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /scheduler/tasks/${id}`)
  return res.json()
}

export async function updateScheduledTask(id: string, body: Partial<ScheduledTaskCreate>): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /scheduler/tasks/${id}`)
  return res.json()
}

export async function deleteScheduledTask(id: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /scheduler/tasks/${id}`)
}

export async function pauseScheduledTask(id: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(id)}/pause`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${id}/pause`)
  return res.json()
}

export async function resumeScheduledTask(id: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${id}/resume`)
  return res.json()
}

export async function triggerScheduledTask(id: string): Promise<{ status: string }> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(id)}/trigger`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${id}/trigger`)
  return res.json()
}

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

export async function getScheduledTask(slug: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(slug)}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /scheduler/tasks/${slug}`)
  return res.json()
}

export async function updateScheduledTask(slug: string, body: Partial<ScheduledTaskCreate>): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /scheduler/tasks/${slug}`)
  return res.json()
}

export async function deleteScheduledTask(slug: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(slug)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /scheduler/tasks/${slug}`)
}

export async function pauseScheduledTask(slug: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(slug)}/pause`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${slug}/pause`)
  return res.json()
}

export async function resumeScheduledTask(slug: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(slug)}/resume`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${slug}/resume`)
  return res.json()
}

export async function triggerScheduledTask(slug: string): Promise<{ status: string }> {
  const res = await fetch(`${apiBaseUrl()}/scheduler/tasks/${encodeURIComponent(slug)}/trigger`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${slug}/trigger`)
  return res.json()
}

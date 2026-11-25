/**
 * OpenAgentd API client — what a session waits for, and stopping one of its
 * background commands.
 */

import { apiBaseUrl } from '../base-url'
import type { WaitingResponse } from '../types'
import { parseDetailOrThrow } from './_shared'

/**
 * What a session whose turn ended still waits for: its subagents still
 * running, the sessions in other workspaces that owe it a reply, and its
 * background commands still running.
 */
export async function listWaiting(sessionId: string): Promise<WaitingResponse> {
  const res = await fetch(`${apiBaseUrl()}/agent/sessions/${encodeURIComponent(sessionId)}/waiting`)
  if (!res.ok) await parseDetailOrThrow(res, 'listWaiting')
  return res.json()
}

/** Stop a session's background command by its number. False when it already ended. */
export async function stopCommand(sessionId: string, number: number): Promise<boolean> {
  const res = await fetch(`${apiBaseUrl()}/agent/sessions/${encodeURIComponent(sessionId)}/commands/${number}/stop`, { method: 'POST' })
  if (res.status === 404) return false
  if (!res.ok) await parseDetailOrThrow(res, 'POST /agent/sessions/{id}/commands/{n}/stop')
  return true
}

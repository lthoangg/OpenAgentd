/**
 * OpenAgentd API client — a tool call's output, fetched on demand.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'

export interface ToolResultResponse {
  tool_call_id: string
  name: string | null
  content: string
}

/**
 * The output of a finished tool call. History rows and the live
 * ``tool_end`` leave most tools' output out (``result_omitted``); the card
 * asks for it when the user opens the call. Found in the session or any
 * session under it (a member's call).
 */
export async function toolResult(sessionId: string, toolCallId: string): Promise<ToolResultResponse> {
  const res = await fetch(`${apiBaseUrl()}/agent/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(toolCallId)}`)
  if (!res.ok) await parseDetailOrThrow(res, 'toolResult')
  return res.json()
}

/**
 * Reading the rows a history page or a since-delta carries: where a revert
 * cuts them, which are queued steers, the newest row (the sync watermark), and
 * whether they hold anything the client does not show yet.
 */
import { isRestartNoteExtra } from '@/lib/restart-note'
import { readBlocks } from '@/utils/blocks'
import { userMessageSender } from '@/utils/messages'
import type { OrphanToolResult } from '@/utils/messages'
import { sentFrom } from '@/utils/workspace-messages'
import type { AgentStore } from './types'
import type { MessageResponse, SessionHistoryResponse } from '@/api/types'

export function revertBoundaryTime(session: { revert?: { message_id?: string; created_at?: string } | null; messages: MessageResponse[] }): number | null {
  if (!session.revert) return null
  if (session.revert.created_at) {
    return new Date(session.revert.created_at).getTime()
  }
  const boundaryId = session.revert?.message_id
  if (!boundaryId) return null
  const boundary = session.messages.find((msg) => msg.id === boundaryId)
  return boundary?.created_at ? new Date(boundary.created_at).getTime() : null
}

export function messagesBeforeTime(messages: MessageResponse[], boundaryTime: number | null): MessageResponse[] {
  if (boundaryTime === null) return messages
  return messages.filter((msg) => {
    if (!msg.created_at) return true
    return new Date(msg.created_at).getTime() < boundaryTime
  })
}

export function messagesBeforeRevert(session: { revert?: { message_id?: string } | null; messages: MessageResponse[] }): MessageResponse[] {
  const boundaryId = session.revert?.message_id
  if (boundaryId) {
    const idx = session.messages.findIndex((msg) => msg.id === boundaryId)
    if (idx >= 0) {
      return session.messages.slice(0, idx)
    }
  }
  return messagesBeforeTime(session.messages, revertBoundaryTime(session))
}

/**
 * Queued rows the user can steer with, as pending messages. A member's report
 * or another workspace's reply (``from_agent``) is queued for the lead too,
 * but it is no steer: shown as one, Stop called it off — deleting the report
 * and pasting it into the composer. It appears as a report once read.
 */
export function queuedMessagesFromHistory(sessionId: string, messages: MessageResponse[]) {
  return messages
    // A goal's queued continuation and a restart's note are the runtime's, not the user's message.
    .filter((msg) => msg.role === 'user' && (msg.kind === 'queued' || msg.extra?.queue_status === 'queued') && !userMessageSender(msg) && !msg.extra?.goal_turn && !isRestartNoteExtra(msg.extra))
    .map((msg) => {
      const sender = sentFrom(msg.extra)
      return {
        id: msg.id,
        sessionId,
        content: msg.content ?? '',
        submittedAt: msg.created_at ? new Date(msg.created_at).getTime() : undefined,
        attachments: msg.attachments ?? undefined,
        sentFromWorkspace: sender?.workspaceName,
        sentFromSession: sender ? { sessionId: sender.sessionId, workspace: sender.workspace } : undefined,
        heldUntilTurnEnd: msg.extra?.hold_until_turn_end === true || undefined,
        mentions: Array.isArray(msg.extra?.mentions) && msg.extra.mentions.length > 0 ? msg.extra.mentions as string[] : undefined,
      }
    })
}

/**
 * Newest ``created_at`` across the lead and every member session.
 *
 * Valid "we hold everything before this" watermark because a full page returns
 * the *newest* rows of each session: if a member had a message after this
 * instant, that message would itself be the maximum.
 */
export function newestMessageAt(history: {
  lead: { messages: MessageResponse[] }
  members: Array<{ messages: MessageResponse[] }>
}): string | null {
  let newest: string | null = null
  const consider = (msgs: MessageResponse[]) => {
    for (const msg of msgs) {
      // Message ids are uuid7: globally creation-ordered across lead/member
      // sessions. Unlike per-session seq or display-only created_at, this
      // watermark also discovers a newly anchored compaction summary.
      if (newest === null || msg.id > newest) newest = msg.id
    }
  }
  consider(history.lead.messages)
  for (const member of history.members) consider(member.messages)
  return newest
}

export function fastModeFromMessages(messages: MessageResponse[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index]
    if (msg.role === 'user') return msg.extra?.service_tier === 'fast'
  }
  return false
}

/** Every row a since-delta carries: the lead's, then each member's. */
export function deltaRows(delta: SessionHistoryResponse): MessageResponse[] {
  return [...delta.lead.messages, ...delta.members.flatMap((member: { messages: MessageResponse[] }) => member.messages)]
}

/**
 * True when ``rows`` hold something the client shows nowhere: a user row, a
 * tool call, or a tool result whose card is missing. Matched by tool-call id
 * and user-row id: a confirmed step can carry its live block's id
 * (``keepLiveIds``), so a block id says nothing here.
 */
export function holdsUnseenRows(state: AgentStore, rows: MessageResponse[]): boolean {
  const shownToolCalls = new Set<string>()
  const shownIds = new Set<string>()
  for (const stream of Object.values(state.agentStreams)) {
    for (const block of [...readBlocks(stream.blocks), ...readBlocks(stream.currentBlocks)]) {
      shownIds.add(block.id)
      if (block.toolCallId) shownToolCalls.add(block.toolCallId)
    }
  }
  return rows.some((row) => {
    if (row.role === 'user') return row.kind !== 'queued' && row.extra?.queue_status !== 'queued' && !shownIds.has(row.id)
    if (row.role === 'tool') return Boolean(row.tool_call_id) && !shownToolCalls.has(row.tool_call_id as string)
    return (row.tool_calls ?? []).some((call: { id?: string }) => Boolean(call.id) && !shownToolCalls.has(call.id as string))
  })
}

/** The tool results ``rows`` carry, keyed by tool-call id. */
export function toolResultsOf(rows: MessageResponse[]): Record<string, OrphanToolResult> {
  const results: Record<string, OrphanToolResult> = {}
  for (const row of rows) {
    if (row.role !== 'tool' || !row.tool_call_id) continue
    const extra = row.extra as { duration_ms?: number; mcp_app?: Record<string, unknown> } | null
    const result: OrphanToolResult = { content: row.content || '' }
    if (row.result_omitted) result.omittedBytes = row.result_bytes ?? 0
    if (typeof extra?.duration_ms === 'number') result.serverDurationMs = extra.duration_ms
    if (extra?.mcp_app) result.mcpApp = extra.mcp_app
    results[row.tool_call_id] = result
  }
  return results
}

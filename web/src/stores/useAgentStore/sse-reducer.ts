/**
 * The session stream's dispatch table: each event goes to its handler, kept
 * with the other events of its family in a sibling ``sse-*.ts`` module.
 */
import { applyQuestionResolution } from './helpers'
import { onAgentNotConfigured, onAgentStatus, onError, onProviderStatus } from './sse-agent-status'
import { onSummarizationContent, onSummarizationEnd, onSummarizationStart } from './sse-compaction'
import { applySSEDeltaBatch, onToolCall, onToolEnd, onToolStart } from './sse-content'
import { onQuestionAsked, onQuestionResolved } from './sse-questions'
import { onDone, onQueuedTurnStart } from './sse-turn'
import { onUsage } from './sse-usage'
import type { StoreGet, StoreSet } from './types'
import type { SSEEventType } from '@/api/types'

/**
 * Session-stream events the reducer deliberately drops, with the reason.
 * Every other contract event needs a `case` below (`sse-contract.test.ts`).
 */
export const IGNORED_SSE_EVENTS: Partial<Record<SSEEventType, string>> = {
  rate_limit: 'always followed by a provider_status "retrying" event carrying the same retry_after, which the UI renders',
}

interface CreateSSEHandlerArgs {
  set: StoreSet
  get: StoreGet
}

export function createSSEHandler({ set, get }: CreateSSEHandlerArgs) {
  return (type: string, data: unknown) => {
    const d = data as Record<string, unknown>

    switch (type) {
      case 'session': {
        set((draft) => {
          draft.sessionId = d.session_id as string
          // A fresh turn is starting: any card still on screen belongs to the
          // turn that just ended, and the backend has already superseded it.
          // Record that outcome rather than just clearing — a bare clear leaves
          // the card with nothing to show but its "waiting" fallback.
          applyQuestionResolution(draft, null, null, 'superseded')
        })
        break
      }

      case 'thinking':
      case 'message': {
        applySSEDeltaBatch(set, [{ type, data: d }])
        break
      }

      case 'tool_call': {
        onToolCall(set, d)
        break
      }

      case 'tool_start': {
        onToolStart(set, d)
        break
      }

      case 'tool_output_delta': {
        applySSEDeltaBatch(set, [{ type, data: d }])
        break
      }

      case 'tool_end': {
        onToolEnd(set, get, d)
        break
      }

      case 'provider_status': {
        onProviderStatus(set, d)
        break
      }

      case 'usage': {
        onUsage(set, d)
        break
      }

      case 'queued_turn_start': {
        onQueuedTurnStart(set, get, d)
        break
      }

      case 'interaction_mode': {
        // A switch queued behind an active turn has landed. Adopt it and drop
        // the pending marker so the toggle stops advertising a queued change.
        const mode = d.interaction_mode
        if (mode === 'code' || mode === 'plan') {
          set((draft) => {
            draft.sessionInteractionMode = mode
            draft.sessionPendingInteractionMode = null
          })
        }
        break
      }

      case 'agent_status': {
        onAgentStatus(set, d)
        break
      }

      case 'question_asked': {
        onQuestionAsked(set, d)
        break
      }

      // Both resolutions are also delivered to the client that triggered them,
      // so this is the single place the card is closed. That keeps a second
      // device (or a second tab) in sync with no extra round-trip, and makes
      // the local optimistic path unnecessary.
      case 'question_answered':
      case 'question_dismissed': {
        onQuestionResolved(set, type, d)
        break
      }

      case 'done': {
        onDone(set)
        break
      }

      case 'error': {
        onError(set, d)
        break
      }

      case 'summarization_start': {
        onSummarizationStart(set, d)
        break
      }

      case 'summarization_content': {
        onSummarizationContent(set, d)
        break
      }

      case 'summarization_end': {
        onSummarizationEnd(set, d)
        break
      }

      case 'agent_not_configured': {
        onAgentNotConfigured(set, d)
        break
      }

      case 'subagent_spawned':
      case 'subagent_status': {
        const leadId = (d.lead_session_id as string) || get().sessionId
        if (leadId) {
          set((draft) => {
            draft.cacheInvalidations.push({ kind: 'subagents', sessionId: leadId })
          })
        }
        break
      }
    }
  }
}

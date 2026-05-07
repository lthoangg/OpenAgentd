/**
 * SSE event → store mutation reducer for the team chat stream.
 *
 * Factored out as a free function ``createSSEHandler({ set, get })`` so
 * the bulk of the switch (one case per server event type) can live
 * outside the store creator. Behaviour is identical to the previous
 * inline ``_handleSSEEvent``: each case takes the loosely-typed event
 * payload, narrows it, and applies the matching draft mutation via
 * Immer.
 *
 * Handled events:
 *   - ``session``        — session id arrives.
 *   - ``title_update``   — server-generated session title.
 *   - ``thinking``       — model thinking-stream chunk for one agent.
 *   - ``message``        — model message-stream chunk for one agent.
 *   - ``tool_call``      — tool reservation (creates an empty tool block).
 *   - ``tool_start``     — tool args arrive (may stream as JSON fragments).
 *   - ``tool_end``       — tool result arrives; may invalidate query caches
 *                          (wiki / workspace files / scheduler / todos)
 *                          based on which root the tool touched.
 *   - ``usage``          — per-delta token counters (turn_total summary skipped).
 *   - ``inbox``          — cross-agent message; rendered as a synthetic user
 *                          block on the recipient stream so split view shows it.
 *   - ``agent_status``   — per-agent working/available/error transitions; also
 *                          recomputes the team-wide ``isTeamWorking`` flag.
 *   - ``done``           — flush ``currentBlocks`` into ``blocks``, stamp any
 *                          unstamped block with the completion time, commit
 *                          ``_completionBase`` for cross-turn token math.
 *   - ``error``          — propagate the error message and clear working flag.
 *
 * Cache invalidation: rather than calling ``queryClient.invalidateQueries``
 * directly (which would couple the store to TanStack Query), the
 * ``tool_end`` case pushes domain events onto ``draft.cacheInvalidations``.
 * A React-side subscriber in ``routes/team.tsx`` drains the queue via
 * ``_drainCacheInvalidations`` and performs the actual invalidation —
 * mirroring the pre-existing sessionId/title bridge in that file. This
 * keeps the store free of TanStack imports.
 */
import {
  appendThinking,
  appendText,
  initTool,
  addTool,
  completeTool,
  generateBlockId,
} from '@/utils/blocks'
import { createDefaultAgentStream } from './defaults'
import {
  WIKI_MUTATING_TOOLS,
  NOTE_TOOLS,
  SCHEDULER_MUTATING_TOOLS,
  TODO_MUTATING_TOOLS,
  touchesWiki,
} from './helpers'
import type { CacheInvalidation, TeamStore } from './types'

type Setter = (fn: (draft: TeamStore) => void) => void
type Getter = () => TeamStore

interface CreateSSEHandlerArgs {
  set: Setter
  get: Getter
}

export function createSSEHandler({ set, get }: CreateSSEHandlerArgs) {
  return (type: string, data: unknown) => {
    const d = data as Record<string, unknown>

    switch (type) {
      case 'session': {
        set((draft) => { draft.sessionId = d.session_id as string })
        break
      }

      case 'title_update': {
        set((draft) => { draft.sessionTitle = d.title as string })
        break
      }

      case 'thinking': {
        const agent = d.agent as string
        set((draft) => {
          if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
          draft.agentStreams[agent].currentBlocks = appendThinking(
            draft.agentStreams[agent].currentBlocks, d.text as string
          )
        })
        break
      }

      case 'message': {
        const agent = d.agent as string
        set((draft) => {
          if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
          draft.agentStreams[agent].currentBlocks = appendText(
            draft.agentStreams[agent].currentBlocks, d.text as string
          )
        })
        break
      }

      case 'tool_call': {
        if (TODO_MUTATING_TOOLS.has(d.name as string)) break
        const agent = d.agent as string
        set((draft) => {
          if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
          draft.agentStreams[agent].currentBlocks = initTool(
            draft.agentStreams[agent].currentBlocks,
            d.name as string,
            d.tool_call_id as string | undefined,
          )
        })
        break
      }

      case 'tool_start': {
        if (TODO_MUTATING_TOOLS.has(d.name as string)) break
        const agent = d.agent as string
        set((draft) => {
          if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
          draft.agentStreams[agent].currentBlocks = addTool(
            draft.agentStreams[agent].currentBlocks,
            d.name as string,
            d.arguments as string | undefined,
            d.tool_call_id as string | undefined,
          )
        })
        break
      }

      case 'tool_end': {
        const agent = d.agent as string
        const toolName = d.name as string
        const toolCallId = d.tool_call_id as string | undefined
        if (!TODO_MUTATING_TOOLS.has(toolName)) {
          set((draft) => {
            if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
            draft.agentStreams[agent].currentBlocks = completeTool(
              draft.agentStreams[agent].currentBlocks,
              toolName,
              toolCallId,
              d.result as string | undefined,
            )
          })
        }
        // Build the domain events this tool_end should fire — one
        // per affected cache.  The bridge in routes/team.tsx drains
        // the queue and performs the actual TanStack invalidations.
        //
        // Wiki vs. workspace-files: write/edit/rm with a path
        // targeting ``wiki/`` invalidates the wiki tree; anything
        // else landed in the session workspace.  Path is read from
        // the matching tool block's stored args (captured on
        // tool_start).
        const events: CacheInvalidation[] = []
        if (NOTE_TOOLS.has(toolName)) {
          events.push({ kind: 'wiki' })
        }
        if (WIKI_MUTATING_TOOLS.has(toolName)) {
          const stream = get().agentStreams[agent]
          const block = stream?.currentBlocks.find(
            (b) => b.type === 'tool' && (toolCallId ? b.toolCallId === toolCallId : b.toolName === toolName),
          )
          if (touchesWiki(toolName, block?.toolArgs)) {
            events.push({ kind: 'wiki' })
          } else {
            // Guarded by sessionId so stale turns after newSession()
            // don't queue an event keyed on a mismatched session id.
            const sid = get().sessionId
            if (sid) events.push({ kind: 'workspace_files', sessionId: sid })
          }
        }
        if (SCHEDULER_MUTATING_TOOLS.has(toolName)) {
          events.push({ kind: 'scheduler' })
        }
        if (TODO_MUTATING_TOOLS.has(toolName)) {
          const sid = get().sessionId
          if (sid) events.push({ kind: 'todos', sessionId: sid })
        }
        if (events.length > 0) {
          set((draft) => { draft.cacheInvalidations.push(...events) })
        }
        break
      }

      case 'usage': {
        const meta = d.metadata as Record<string, unknown> | undefined
        // Skip the aggregated turn_total summary — use per-delta events only.
        if (meta?.turn_total) break
        // Agent name lives in metadata, not top-level.
        const agent = (meta?.agent as string) ?? (d.agent as string)
        if (!agent) break
        set((draft) => {
          if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
          const stream = draft.agentStreams[agent]
          const u = stream.usage
          // completion_tokens is a running total within the current turn (not a delta).
          // Add _completionBase (committed from prior turns) to get the session total.
          u.promptTokens     = (d.prompt_tokens as number) || 0
          u.completionTokens = stream._completionBase + ((d.completion_tokens as number) || 0)
          // cached_tokens is null on most chunks; preserve last known value.
          u.cachedTokens     = (d.cached_tokens as number) ?? u.cachedTokens
          u.totalTokens      = u.promptTokens + u.completionTokens
        })
        break
      }

      case 'inbox': {
        // Push inbox message as user block so split view shows it live.
        const agent = d.agent as string
        set((draft) => {
          if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
          draft.agentStreams[agent].currentBlocks.push({
            id: generateBlockId(),
            type: 'user',
            content: d.content as string,
            extra: { from_agent: d.from_agent as string },
            timestamp: new Date(),
          })
        })
        break
      }

      case 'agent_status': {
        const agent = d.agent as string
        const status = d.status as string
        set((draft) => {
          if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
          if (status === 'working') {
            draft.agentStreams[agent].status = 'working'
            draft.isTeamWorking = true
          } else if (status === 'available') {
            draft.agentStreams[agent].status = 'available'
          } else if (status === 'error') {
            draft.agentStreams[agent].status = 'error'
            draft.agentStreams[agent].lastError =
              (d.metadata as Record<string, unknown>)?.message as string ?? null
          }
          // Recompute global flag — keeps header/composer in sync when a single
          // agent goes idle even before the whole team emits `done`. `done` still
          // forces false, so this is a safe superset of the prior behaviour.
          if (status !== 'working') {
            draft.isTeamWorking = Object.values(draft.agentStreams).some(
              (s) => s.status === 'working',
            )
          }
        })
        break
      }

      case 'done': {
        set((draft) => {
          draft.isTeamWorking = false
          const completedAt = new Date()
          Object.keys(draft.agentStreams).forEach((name) => {
            const stream = draft.agentStreams[name]
            if (stream.currentBlocks.length > 0) {
              // Stamp blocks that have no timestamp with the completion time
              const stamped = stream.currentBlocks.map((b) =>
                b.timestamp ? b : { ...b, timestamp: completedAt },
              )
              // Flush currentBlocks into finalized blocks
              stream.blocks = [...stream.blocks, ...stamped]
              stream.currentBlocks = []
            }
            // Commit this turn's output so next turn accumulates on top
            stream._completionBase = stream.usage.completionTokens
            // Preserve error status so the red pane stays visible until the
            // user retries (agent_status → working will clear it).
            if (stream.status !== 'error') stream.status = 'available'
          })
        })
        // Drain the full pending queue in one shot. Combine all queued message
        // texts into a single turn (joined by double newline) and merge their
        // file lists. Clear the queue atomically before calling sendMessage so
        // nothing re-enqueues if the lead briefly appears working again.
        const pending = get()._pendingMessages
        if (pending.length > 0) {
          const content = pending.map((m) => m.content).join('\n\n')
          const files = pending.flatMap((m) => m.files ?? [])
          set((draft) => { draft._pendingMessages = [] })
          void get().sendMessage(content, files.length > 0 ? files : undefined)
        }
        break
      }

      case 'error': {
        set((draft) => {
          draft.error = d.message as string
          draft.isTeamWorking = false
        })
        break
      }
    }
  }
}

import type { StateCreator } from 'zustand'
import { postAgentChat, postAgentCommand, agentStream } from '@/api/client'
import { applyQuestionResolution, applyRevertBoundary, markRestartPending } from './helpers'
import {
  applySSEDeltaBatch,
  createSSEHandler,
  isBufferedSSEDelta,
  type BufferedSSEDelta,
} from './sse-reducer'
import { isTransientNetworkError } from '@/utils/errors'
import type { AgentStore } from './types'

export function clearReconnectTimer(state: Pick<AgentStore, '_reconnectTimer'>) {
  if (state._reconnectTimer !== null) {
    clearTimeout(state._reconnectTimer)
    state._reconnectTimer = null
  }
}

function mergeChangedPaths(
  changed: { added: string[]; modified: string[]; removed: string[] } | undefined,
): string[] | undefined {
  if (!changed) return undefined
  const seen = new Set<string>()
  for (const p of changed.added) seen.add(p)
  for (const p of changed.modified) seen.add(p)
  for (const p of changed.removed) seen.add(p)
  return [...seen]
}

function enqueueWorkspaceInvalidation(
  set: (fn: (draft: AgentStore) => void) => void,
  get: () => AgentStore,
  sessionId: string,
  paths?: string[],
) {
  const workspace = get()._workspace
  if (workspace && paths !== undefined) {
    if (paths.length === 0) return
    set((draft) => {
      draft.cacheInvalidations.push({
        kind: 'coding_workspace_paths',
        workspace,
        paths,
      })
    })
    return
  }
  set((draft) => {
    draft.cacheInvalidations.push(
      workspace
        ? { kind: 'coding_workspace', workspace }
        : { kind: 'workspace_files', sessionId },
    )
  })
}

export type StreamSlice = Pick<
  AgentStore,
  | 'agentStreams'
  | 'isAgentWorking'
  | 'pendingQuestion'
  | 'resolvedQuestions'
  | 'isConnected'
  | 'error'
  | 'setupRequired'
  | '_abortController'
  | '_reconnectTimer'
  | '_reconnectAttempts'
  | '_unloading'
  | 'cacheInvalidations'
  | 'compactAgent'
  | 'undoAgent'
  | 'redoAgent'
  | 'redoAllAgent'
  | 'pendingDraft'
  | 'consumePendingDraft'
  | 'setPendingDraft'
  | 'stopAgent'
  | 'connectStream'
  | 'resolveQuestion'
  | 'markTurnResuming'
  | 'dismissSetupRequired'
  | '_drainCacheInvalidations'
  | '_handleSSEEvent'
>

export const createStreamSlice: StateCreator<
  AgentStore,
  [['zustand/immer', never]],
  [],
  StreamSlice
> = (set, get) => ({
  agentStreams: {},
  isAgentWorking: false,
  pendingQuestion: null,
  resolvedQuestions: {},
  isConnected: false,
  error: null,
  setupRequired: null,
  pendingDraft: null,
  _abortController: null,
  _reconnectTimer: null,
  _reconnectAttempts: 0,
  _unloading: false,
  cacheInvalidations: [],

  compactAgent: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to compact' })
      return
    }

    try {
      const submittedAt = Date.now()
      set((draft) => {
        draft.isAgentWorking = true
        draft.error = null
        if (draft.leadName && draft.agentStreams[draft.leadName]) {
          draft.agentStreams[draft.leadName]._turnStartedAt = submittedAt
        }
      })
      await postAgentCommand('compact', sessionId)
      set((draft) => {
        draft._leadRevertTime = null
        Object.values(draft.agentStreams).forEach((stream) => {
          stream._revertedSuffix = []
          stream.revertedCount = 0
          stream.revertedMessages = []
        })
      })
      get().connectStream()
    } catch (err) {
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to compact'
        draft.isAgentWorking = false
      })
    }
  },

  undoAgent: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to undo' })
      return
    }
    // Reverting mid-stream orphans the in-flight assistant tokens
    // (currentBlocks gets spliced into _revertedSuffix while SSE keeps
    // pushing deltas). Force the user to /stop first — matches the
    // backend precondition in AgentSession.handle_undo.
    if (get().isAgentWorking) {
      set((draft) => {
        draft.error = 'Cannot undo while agents are working — /stop first'
      })
      return
    }

    try {
      set((draft) => { draft.error = null })
      const response = await postAgentCommand('undo', sessionId)
      const boundaryIso = response.message?.created_at
      const boundaryTime = boundaryIso ? new Date(boundaryIso).getTime() : null
      set((draft) => {
        draft._leadRevertTime = boundaryTime
        Object.values(draft.agentStreams).forEach((stream) => {
          stream._unsyncedBlockIds = []
          applyRevertBoundary(stream, boundaryTime, {
            includeCurrent: true,
            boundaryId: response.message?.id ?? null,
            boundaryContent: response.message?.content ?? null,
          })
        })
        if (response.message?.role === 'user' && !response.message.is_summary) {
          draft.pendingDraft = {
            content: response.message.content ?? '',
            attachments: response.message.attachments ?? [],
          }
        }
      })
      enqueueWorkspaceInvalidation(
        set,
        get,
        sessionId,
        mergeChangedPaths(response.changed_paths),
      )
      return response
    } catch (err) {
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to undo'
      })
      return undefined
    }
  },

  consumePendingDraft: () => {
    const current = get().pendingDraft
    if (current) {
      set((draft) => { draft.pendingDraft = null })
    }
    return current
  },
  setPendingDraft: (draftValue) => {
    set((draft) => { draft.pendingDraft = draftValue })
  },

  redoAgent: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to redo' })
      return undefined
    }
    if (get().isAgentWorking) {
      set((draft) => {
        draft.error = 'Cannot redo while agents are working — /stop first'
      })
      return undefined
    }

    try {
      set((draft) => { draft.error = null })
      const response = await postAgentCommand('redo', sessionId)
      const boundaryIso = response.message?.created_at
      const boundaryTime = boundaryIso ? new Date(boundaryIso).getTime() : null
      set((draft) => {
        draft._leadRevertTime = boundaryTime
        Object.values(draft.agentStreams).forEach((stream) => {
          stream._unsyncedBlockIds = []
          applyRevertBoundary(stream, boundaryTime, {
            boundaryId: response.message?.id ?? null,
            boundaryContent: response.message?.content ?? null,
          })
        })
      })
      enqueueWorkspaceInvalidation(
        set,
        get,
        sessionId,
        mergeChangedPaths(response.changed_paths),
      )
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('No undone message to redo')) {
        set((draft) => {
          draft._leadRevertTime = null
          Object.values(draft.agentStreams).forEach((stream) => {
            stream._unsyncedBlockIds = []
            applyRevertBoundary(stream, null)
          })
        })
      } else {
        set((draft) => {
          draft.error = `Failed to redo: ${message}`
        })
      }
      return undefined
    }
  },

  redoAllAgent: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to redo' })
      return
    }
    if (get().isAgentWorking) {
      set((draft) => {
        draft.error = 'Cannot redo while agents are working — /stop first'
      })
      return
    }

    try {
      set((draft) => { draft.error = null })
      const response = await postAgentCommand('redo-all', sessionId)
      set((draft) => {
        draft._leadRevertTime = null
        Object.values(draft.agentStreams).forEach((stream) => {
          stream._unsyncedBlockIds = []
          applyRevertBoundary(stream, null)
        })
      })
      enqueueWorkspaceInvalidation(
        set,
        get,
        sessionId,
        mergeChangedPaths(response.changed_paths),
      )
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('No undone message to redo')) {
        set((draft) => {
          draft._leadRevertTime = null
          Object.values(draft.agentStreams).forEach((stream) => {
            stream._unsyncedBlockIds = []
            applyRevertBoundary(stream, null)
          })
        })
      } else {
        set((draft) => {
          draft.error = `Failed to redo: ${message}`
        })
      }
      return undefined
    }
  },

  resolveQuestion: (
    questionId: string,
    answers: string[][] | null,
    reason: string | null,
  ) => {
    set((draft) => {
      applyQuestionResolution(draft, questionId, answers, reason)
    })
  },

  markTurnResuming: () => {
    set((draft) => {
      const lead = draft.leadName ? draft.agentStreams[draft.leadName] : undefined
      if (!lead) return
      // The answer restarts the turn with no new user message, so nothing else
      // marks it live until the first token — which can be seconds away.
      draft.isAgentWorking = true
      markRestartPending(lead)
      if (lead.status === 'waiting_input') lead.status = 'working'
    })
    // Treat an answer as a stream handoff, even when isConnected still says
    // true. That flag is optimistic (set before fetch attaches) and can remain
    // stale after an aborted/suspended socket, which leaves the resumed tokens
    // streaming to no browser until reload. Reattach unconditionally; attach
    // replay covers anything emitted during the handoff.
    get().connectStream()
  },

  stopAgent: async () => {
    const sessionId = get().sessionId
    if (!sessionId || !get().isAgentWorking) return

    try {
      const workspace = get()._workspace
      if (!workspace) return
      await postAgentChat(null, sessionId, true, workspace)
      // Reloads immediately. The interrupt POST only *signals* cancellation, so
      // the trailing `done` can still be seconds away (a cancelled shell tool
      // alone can spend 2s draining stdout plus 5s reaping) — but the reload no
      // longer trusts the stale client-side `isAgentWorking`, so it adopts the
      // server's finished turn cleanly instead of racing that `done`.
      await get().loadSession(sessionId, get()._workspace)
    } catch (err) {
      console.warn('stopAgent failed', err)
    }
  },

  connectStream: () => {
    const sessionId = get().sessionId
    if (!sessionId) return new AbortController()
    const generation = get()._sessionGeneration

    get()._abortController?.abort()
    set((draft) => {
      clearReconnectTimer(draft)
    })
    const abort = new AbortController()
    set((draft) => {
      draft.isConnected = true
      draft._abortController = abort
      // Every attach replays the accumulated turn text as one snapshot chunk
      // per kind before live events resume, so re-arm the replay guard for all
      // known streams. Without this a reconnect mid-turn doubles the visible
      // text; with it armed *only* here, ordinary deltas that happen to repeat
      // their prefix are no longer mistaken for replays and dropped.
      for (const stream of Object.values(draft.agentStreams)) {
        stream._replayPending = { message: true, thinking: true }
      }
    })

    // Providers can emit dozens of text/tool-output deltas per second. Applying
    // each in its own immer transaction forces the full chat selector/render
    // path to run per token. Coalesce only the append-only delta events into a
    // ~60 fps window; flush synchronously before every structural event so SSE
    // ordering remains exact (e.g. final text before `done`).
    let bufferedDeltas: BufferedSSEDelta[] = []
    let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null
    const flushBufferedDeltas = () => {
      if (deltaFlushTimer !== null) {
        clearTimeout(deltaFlushTimer)
        deltaFlushTimer = null
      }
      if (bufferedDeltas.length === 0) return
      const events = bufferedDeltas
      bufferedDeltas = []
      const current = get()
      if (current.sessionId !== sessionId || current._sessionGeneration !== generation) return
      applySSEDeltaBatch(set, events)
    }
    const queueBufferedDelta = (event: BufferedSSEDelta) => {
      bufferedDeltas.push(event)
      if (deltaFlushTimer === null) {
        deltaFlushTimer = setTimeout(flushBufferedDeltas, 16)
      }
    }
    // A manual reconnect aborts the old fetch. Flush already-received deltas
    // before the replacement stream opens; a session-generation mismatch
    // safely discards them during a session switch.
    abort.signal.addEventListener('abort', flushBufferedDeltas, { once: true })

    // Reopening the moment the backend closes is right when the connection was
    // doing something — but a stream that closes having delivered nothing will
    // do it again, so an immediate retry becomes a request storm with no error
    // to trigger the backoff below.
    let receivedAnyEvent = false
    const scheduleReconnect = () => {
      set((draft) => {
        draft.isConnected = false
        clearReconnectTimer(draft)
        // Retry quickly for brief Wi-Fi switches, then back off while a
        // mobile device remains offline so background wakeups do not run
        // an unbounded 1.5-second polling loop. Any received SSE event
        // resets the attempt counter.
        const delay = Math.min(30_000, 1_500 * 2 ** draft._reconnectAttempts)
        draft._reconnectAttempts += 1
        draft._reconnectTimer = setTimeout(() => {
          set((timerDraft) => {
            if (timerDraft._reconnectTimer !== null) timerDraft._reconnectTimer = null
          })
          const s = get()
          if (s.sessionId !== sessionId || s._sessionGeneration !== generation) return
          if (s._unloading || s.isConnected) return
          get().connectStream()
        }, delay)
      })
    }

    agentStream(
      sessionId,
      {
        onEvent: (type, data) => {
          // A read() already in flight can resolve with a chunk in the same
          // tick this exact connection was superseded (aborted in favor of a
          // fresh one) for the same session/generation, which the check below
          // alone would not catch. The replacement connection's own attach
          // independently redelivers the same content, so dropping this
          // straggler is safe and avoids double-applying it.
          if (abort.signal.aborted) return
          const current = get()
          if (current._unloading && type === 'error') return
          if (current.sessionId !== sessionId || current._sessionGeneration !== generation) return
          receivedAnyEvent = true
          if (current._reconnectAttempts > 0) {
            set((draft) => { draft._reconnectAttempts = 0 })
          }
          if (isBufferedSSEDelta(type)) {
            queueBufferedDelta({ type, data: data as Record<string, unknown> })
            return
          }
          flushBufferedDeltas()
          current._handleSSEEvent(type, data)
        },
        onParseError: (err) => {
          console.warn(err.message)
        },
        onError: (err) => {
          flushBufferedDeltas()
          abort.signal.removeEventListener('abort', flushBufferedDeltas)
          const current = get()
          if (current.sessionId !== sessionId || current._sessionGeneration !== generation) return
          if (current._unloading || abort.signal.aborted) return
          if (isTransientNetworkError(err)) {
            scheduleReconnect()
            return
          }
          if (!current.isAgentWorking) {
            set((draft) => { draft.isConnected = false })
            return
          }
          set((draft) => { draft.error = err.message; draft.isConnected = false })
        },
        onDone: () => {
          flushBufferedDeltas()
          abort.signal.removeEventListener('abort', flushBufferedDeltas)
          const current = get()
          if (current.sessionId !== sessionId || current._sessionGeneration !== generation) return
          // The underlying `reader.read()` can resolve with `done: true` in
          // the same tick another caller already superseded this connection
          // (aborted it and opened a fresh one) — session/generation still
          // match since a reconnect never bumps either. Without this check,
          // this belated `done` would reopen *again*, leaving two live
          // connections racing and double-applying every subsequent event
          // until a reload. Mirrors the same guard on `onError` above.
          if (abort.signal.aborted) return
          // If the backend closed the SSE channel while the session is
          // still running (e.g. server restart / idle keepalive timeout),
          // reopen the stream immediately so we don't miss events.
          if (current.isAgentWorking && !current._unloading) {
            // A stream that closed having delivered nothing is a stream that
            // will close again — most often the backend has no turn state for
            // this session, so `attach` returns at once. Reopening immediately
            // spins as fast as round trips complete, and a clean close raises
            // no error to reach the backoff in `onError`.
            if (receivedAnyEvent) {
              set((draft) => { draft.isConnected = false })
              get().connectStream()
            } else {
              scheduleReconnect()
            }
            return
          }
          set((draft) => {
            draft.isConnected = false
            // Stream closed with the session idle — the row is no longer
            // running. Patch that flag rather than refetching every loaded
            // page of the session list.
            draft.cacheInvalidations.push({
              kind: 'session_running',
              sessionId,
              running: false,
            })
          })
        },
      },
      abort.signal,
    )
    return abort
  },

  dismissSetupRequired: () => {
    set((draft) => { draft.setupRequired = null })
  },

  _drainCacheInvalidations: () => {
    const events = get().cacheInvalidations
    if (events.length === 0) return []
    set((draft) => { draft.cacheInvalidations = [] })
    return events
  },

  _handleSSEEvent: createSSEHandler({ set, get }),
})

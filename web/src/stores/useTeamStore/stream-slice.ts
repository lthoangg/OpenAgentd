import type { StateCreator } from 'zustand'
import { postTeamChat, postTeamCommand, teamStream } from '@/api/client'
import { applyRevertBoundary } from './helpers'
import {
  applySSEDeltaBatch,
  createSSEHandler,
  isBufferedSSEDelta,
  type BufferedSSEDelta,
} from './sse-reducer'
import { isTransientNetworkError } from '@/utils/errors'
import type { TeamStore } from './types'

export function clearReconnectTimer(state: Pick<TeamStore, '_reconnectTimer'>) {
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
  set: (fn: (draft: TeamStore) => void) => void,
  get: () => TeamStore,
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
  TeamStore,
  | 'agentStreams'
  | 'isTeamWorking'
  | 'isContinuing'
  | 'isConnected'
  | 'error'
  | 'setupRequired'
  | '_abortController'
  | '_reconnectTimer'
  | '_reconnectAttempts'
  | '_unloading'
  | 'cacheInvalidations'
  | 'continueTeam'
  | 'compactTeam'
  | 'undoTeam'
  | 'redoTeam'
  | 'stopTeam'
  | 'connectStream'
  | 'dismissSetupRequired'
  | '_drainCacheInvalidations'
  | '_handleSSEEvent'
>

export const createStreamSlice: StateCreator<
  TeamStore,
  [['zustand/immer', never]],
  [],
  StreamSlice
> = (set, get) => ({
  agentStreams: {},
  isTeamWorking: false,
  isContinuing: false,
  isConnected: false,
  error: null,
  setupRequired: null,
  _abortController: null,
  _reconnectTimer: null,
  _reconnectAttempts: 0,
  _unloading: false,
  cacheInvalidations: [],

  continueTeam: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to continue' })
      return
    }

    try {
      const submittedAt = Date.now()
      set((draft) => {
        draft.isTeamWorking = true
        draft.isContinuing = true
        draft.error = null
        if (draft.leadName && draft.agentStreams[draft.leadName]) {
          draft.agentStreams[draft.leadName]._turnStartedAt = submittedAt
        }
      })
      await postTeamCommand('continue', sessionId)
      get().connectStream()
    } catch (err) {
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to continue'
        draft.isTeamWorking = false
        draft.isContinuing = false
      })
    }
  },

  compactTeam: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to compact' })
      return
    }

    try {
      const submittedAt = Date.now()
      set((draft) => {
        draft.isTeamWorking = true
        draft.error = null
        if (draft.leadName && draft.agentStreams[draft.leadName]) {
          draft.agentStreams[draft.leadName]._turnStartedAt = submittedAt
        }
      })
      await postTeamCommand('compact', sessionId)
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
        draft.isTeamWorking = false
      })
    }
  },

  undoTeam: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to undo' })
      return
    }
    // Reverting mid-stream orphans the in-flight assistant tokens
    // (currentBlocks gets spliced into _revertedSuffix while SSE keeps
    // pushing deltas). Force the user to /stop first — matches the
    // backend precondition in AgentTeam.handle_undo.
    if (get().isTeamWorking) {
      set((draft) => {
        draft.error = 'Cannot undo while agents are working — /stop first'
      })
      return
    }

    try {
      set((draft) => { draft.error = null })
      const response = await postTeamCommand('undo', sessionId)
      const boundaryIso = response.message?.created_at
      const boundaryTime = boundaryIso ? new Date(boundaryIso).getTime() : null
      set((draft) => {
        draft._leadRevertTime = boundaryTime
        Object.values(draft.agentStreams).forEach((stream) => {
          applyRevertBoundary(stream, boundaryTime, {
            includeCurrent: true,
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
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to undo'
      })
      return undefined
    }
  },

  redoTeam: async () => {
    const sessionId = get().sessionId
    if (!sessionId) {
      set((draft) => { draft.error = 'No active session to redo' })
      return
    }

    const MAX_ITER = 200
    const allChangedPaths = new Set<string>()
    let sawChangedPaths = false
    let sawMissingChangedPaths = false
    let sawResponse = false
    try {
      set((draft) => { draft.error = null })
      for (let i = 0; i < MAX_ITER; i++) {
        const response = await postTeamCommand('redo', sessionId)
        sawResponse = true
        const boundaryIso = response.message?.created_at
        const boundaryTime = boundaryIso ? new Date(boundaryIso).getTime() : null
        set((draft) => {
          draft._leadRevertTime = boundaryTime
          Object.values(draft.agentStreams).forEach((stream) => {
            applyRevertBoundary(stream, boundaryTime, {
              boundaryId: response.message?.id ?? null,
              boundaryContent: response.message?.content ?? null,
            })
          })
        })
        if (response.changed_paths === undefined) {
          sawMissingChangedPaths = true
        } else {
          sawChangedPaths = true
        }
        const merged = mergeChangedPaths(response.changed_paths)
        merged?.forEach((p) => allChangedPaths.add(p))
        if (response.message === null) break

        if (i === MAX_ITER - 1) {
          throw new Error('Redo did not reach the live tip')
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('No undone message to redo')) {
        set((draft) => {
          draft._leadRevertTime = null
          Object.values(draft.agentStreams).forEach((stream) => {
            applyRevertBoundary(stream, null)
          })
        })
      } else {
        set((draft) => {
          draft.error = `Failed to redo: ${message}`
        })
      }
    } finally {
      if (sawMissingChangedPaths) {
        enqueueWorkspaceInvalidation(set, get, sessionId)
      } else if (allChangedPaths.size > 0) {
        enqueueWorkspaceInvalidation(
          set,
          get,
          sessionId,
          [...allChangedPaths],
        )
      } else if (sawChangedPaths) {
        enqueueWorkspaceInvalidation(set, get, sessionId, [])
      } else if (sawResponse) {
        enqueueWorkspaceInvalidation(set, get, sessionId)
      }
    }
  },

  stopTeam: async () => {
    const sessionId = get().sessionId
    if (!sessionId || !get().isTeamWorking) return

    try {
      await postTeamChat(null, sessionId, true)
      await get().loadSession(sessionId, get()._workspace)
    } catch (err) {
      console.warn('stopTeam failed', err)
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
    set((draft) => { draft.isConnected = true; draft._abortController = abort })

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

    teamStream(
      sessionId,
      {
        onEvent: (type, data) => {
          const current = get()
          if (current._unloading && type === 'error') return
          if (current.sessionId !== sessionId || current._sessionGeneration !== generation) return
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
            set((draft) => {
              draft.isConnected = false
              clearReconnectTimer(draft)
              // Retry quickly for brief Wi-Fi switches, then back off while a
              // mobile device remains offline so background wakeups do not run
              // an unbounded 1.5-second polling loop. Any received SSE event
              // resets the attempt counter above.
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
            return
          }
          if (!current.isTeamWorking) {
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
          // If the backend closed the SSE channel while the session is
          // still running (e.g. server restart / idle keepalive timeout),
          // reopen the stream immediately so we don't miss events.
          if (current.isTeamWorking && !current._unloading) {
            set((draft) => { draft.isConnected = false })
            get().connectStream()
            return
          }
          set((draft) => {
            draft.isConnected = false
            draft.cacheInvalidations.push({ kind: 'team_sessions' })
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

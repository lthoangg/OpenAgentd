/**
 * useBtwStore — client state of `/btw` side questions, per session: whether
 * the panel is open, which exchange it shows, and the answer streaming in
 * this tab. Stored side questions are server state (``useSideQuestions`` in
 * ``queries/``); ``revision`` tells that hook to refetch after an answer
 * ends or the thread is cleared. No TanStack imports here, like the other
 * stores.
 */
import { create } from 'zustand'
import { askSideQuestion, clearSideQuestions, stopSideQuestion } from '@/api/client'
import { btwAnswerMachine, streamingAnswer, type BtwAnswerEvent, type BtwLive } from '@/stores/btw-state'

export type { BtwLive } from '@/stores/btw-state'

export interface BtwSessionState {
  open: boolean
  /** Index into the panel's exchanges; ``null`` follows the newest. */
  view: number | null
  /** The answer streaming in this tab (``btw-state.ts``). */
  liveAnswer: BtwLive | null
  /** Bumped whenever stored side questions changed. */
  revision: number
}

export const EMPTY_BTW: BtwSessionState = { open: false, view: null, liveAnswer: null, revision: 0 }

interface BtwStore {
  sessions: Record<string, BtwSessionState>
  /** Ask a side question; a running one in the same session is stopped first. */
  ask: (sessionId: string, question: string) => Promise<void>
  reopen: (sessionId: string) => void
  /** Hide the panel; nothing is deleted. */
  dismiss: (sessionId: string) => void
  setView: (sessionId: string, view: number | null) => void
  /** Stop the answer streaming in this tab. */
  stop: (sessionId: string) => Promise<void>
  /** Stop a side question started elsewhere (another tab, before a reload). */
  stopStored: (sessionId: string, id: string) => Promise<void>
  /** Delete every side question of the session. */
  clear: (sessionId: string) => Promise<void>
}

/** The request streaming the live answer, per session. */
const controllers = new Map<string, AbortController>()

export const selectBtw = (sessionId: string | null | undefined) => (s: BtwStore): BtwSessionState =>
  (sessionId ? s.sessions[sessionId] : undefined) ?? EMPTY_BTW

export const useBtwStore = create<BtwStore>()((set, get) => {
  const patch = (sessionId: string, fn: (cur: BtwSessionState) => Partial<BtwSessionState>) =>
    set((state) => {
      const cur = state.sessions[sessionId] ?? EMPTY_BTW
      return { sessions: { ...state.sessions, [sessionId]: { ...cur, ...fn(cur) } } }
    })
  const bump = (sessionId: string) => patch(sessionId, (cur) => ({ revision: cur.revision + 1 }))

  return {
    sessions: {},

    ask: async (sessionId, question) => {
      const previous = get().sessions[sessionId]?.liveAnswer
      if (previous?.kind === 'streaming') {
        await get().stop(sessionId)
        controllers.get(sessionId)?.abort()
      }
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      const current = () => controllers.get(sessionId) === controller
      // Only the newest ask of a session writes its live answer.
      const update = (event: BtwAnswerEvent) => {
        if (!current()) return
        patch(sessionId, (cur) => (cur.liveAnswer ? { liveAnswer: btwAnswerMachine.transition(cur.liveAnswer, event) } : {}))
      }
      patch(sessionId, () => ({
        open: true,
        view: null,
        liveAnswer: streamingAnswer(question),
      }))
      try {
        await askSideQuestion(
          sessionId,
          question,
          (event) => {
            switch (event.type) {
              case 'btw_start':
                // Also sent when a retry restarts the answer.
                update({ type: 'start', id: event.id })
                break
              case 'btw_delta':
                update({ type: 'delta', text: event.text })
                break
              case 'btw_done':
                update({ type: 'done', answer: event.answer })
                break
              case 'btw_error':
                update({ type: 'ended', status: event.status, message: event.message, answer: event.answer })
                break
            }
          },
          controller.signal,
        )
        // The stream ended without a final event (the connection dropped):
        // the server still finishes and stores the answer, so show the
        // stored row from here on.
        if (current() && get().sessions[sessionId]?.liveAnswer?.kind === 'streaming') {
          patch(sessionId, () => ({ liveAnswer: null }))
        }
      } catch (err) {
        update({ type: 'failed', message: err instanceof Error ? err.message : String(err) })
      } finally {
        if (current()) controllers.delete(sessionId)
        bump(sessionId)
      }
    },

    reopen: (sessionId) => patch(sessionId, () => ({ open: true, view: null })),

    dismiss: (sessionId) => patch(sessionId, () => ({ open: false })),

    setView: (sessionId, view) => patch(sessionId, () => ({ view })),

    stop: async (sessionId) => {
      const live = get().sessions[sessionId]?.liveAnswer
      if (!live || live.kind !== 'streaming') return
      if (live.id) {
        // The open stream then ends with ``btw_error`` (stopped) and the
        // partial answer.
        const stopped = await stopSideQuestion(sessionId, live.id).catch(() => false)
        if (stopped) return
      }
      // Not started yet, or already over on the server: end it here. An
      // answer that finished meanwhile (``btw_done`` crossed the stop)
      // stays done: only a streaming answer becomes stopped (``btw-state.ts``).
      controllers.get(sessionId)?.abort()
      controllers.delete(sessionId)
      patch(sessionId, (cur) => (cur.liveAnswer ? { liveAnswer: btwAnswerMachine.transition(cur.liveAnswer, { type: 'stop' }) } : {}))
      bump(sessionId)
    },

    stopStored: async (sessionId, id) => {
      await stopSideQuestion(sessionId, id).catch(() => false)
      bump(sessionId)
    },

    clear: async (sessionId) => {
      controllers.get(sessionId)?.abort()
      controllers.delete(sessionId)
      try {
        await clearSideQuestions(sessionId)
      } finally {
        patch(sessionId, (cur) => ({ liveAnswer: null, view: null, revision: cur.revision + 1 }))
      }
    },
  }
})

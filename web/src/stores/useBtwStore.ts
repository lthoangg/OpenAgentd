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
import type { SideQuestionStatus } from '@/api/types'

export interface BtwLive {
  /** Server id, known from ``btw_start`` on. */
  id: string | null
  question: string
  text: string
  status: SideQuestionStatus
  error: string | null
}

export interface BtwSessionState {
  open: boolean
  /** Index into the panel's exchanges; ``null`` follows the newest. */
  view: number | null
  live: BtwLive | null
  /** Bumped whenever stored side questions changed. */
  revision: number
}

export const EMPTY_BTW: BtwSessionState = { open: false, view: null, live: null, revision: 0 }

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
      const previous = get().sessions[sessionId]?.live
      if (previous?.status === 'streaming') {
        await get().stop(sessionId)
        controllers.get(sessionId)?.abort()
      }
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      const current = () => controllers.get(sessionId) === controller
      // Only the newest ask of a session writes its live answer.
      const update = (fn: (live: BtwLive) => Partial<BtwLive>) => {
        if (!current()) return
        patch(sessionId, (cur) => (cur.live ? { live: { ...cur.live, ...fn(cur.live) } } : {}))
      }
      patch(sessionId, () => ({
        open: true,
        view: null,
        live: { id: null, question, text: '', status: 'streaming', error: null },
      }))
      try {
        await askSideQuestion(
          sessionId,
          question,
          (event) => {
            switch (event.type) {
              case 'btw_start':
                // Also sent when a retry restarts the answer.
                update(() => ({ id: event.id, text: '' }))
                break
              case 'btw_delta':
                update((live) => ({ text: live.text + event.text }))
                break
              case 'btw_done':
                update(() => ({ text: event.answer, status: 'done' }))
                break
              case 'btw_error':
                update(() => ({
                  text: event.answer,
                  status: event.status,
                  error: event.status === 'error' ? event.message : null,
                }))
                break
            }
          },
          controller.signal,
        )
        // The stream ended without a final event (the connection dropped):
        // the server still finishes and stores the answer, so show the
        // stored row from here on.
        if (current() && get().sessions[sessionId]?.live?.status === 'streaming') {
          patch(sessionId, () => ({ live: null }))
        }
      } catch (err) {
        update(() => ({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
      } finally {
        if (current()) controllers.delete(sessionId)
        bump(sessionId)
      }
    },

    reopen: (sessionId) => patch(sessionId, () => ({ open: true, view: null })),

    dismiss: (sessionId) => patch(sessionId, () => ({ open: false })),

    setView: (sessionId, view) => patch(sessionId, () => ({ view })),

    stop: async (sessionId) => {
      const live = get().sessions[sessionId]?.live
      if (!live || live.status !== 'streaming') return
      if (live.id) {
        // The open stream then ends with ``btw_error`` (stopped) and the
        // partial answer.
        const stopped = await stopSideQuestion(sessionId, live.id).catch(() => false)
        if (stopped) return
      }
      // Not started yet, or already over on the server: end it here.
      controllers.get(sessionId)?.abort()
      controllers.delete(sessionId)
      patch(sessionId, (cur) => (cur.live ? { live: { ...cur.live, status: 'stopped' } } : {}))
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
        patch(sessionId, (cur) => ({ live: null, view: null, revision: cur.revision + 1 }))
      }
    },
  }
})

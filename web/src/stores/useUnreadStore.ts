/**
 * Sessions whose latest turn ended while nobody was looking at them.
 *
 * Client-only: the server keeps no read state. Every window hears the same
 * ``session_turn_completed`` events and marks sessions it is not showing; a
 * window showing one (while visible) clears it. Persisted so a reload keeps
 * the marks, and shared through the ``storage`` event so reading a session in
 * one window clears it in the others. Sessions that finish while the app is
 * closed are not marked.
 *
 * In the desktop app, reading also reaches the notch island and the pet: a
 * read here is reported to the shell (``session_read``), and a session read
 * there (or in a window on another origin) arrives as ``session-read`` and
 * clears the mark here without being reported back.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useDocumentVisible } from '@/hooks/use-document-visible'
import { isDesktopShell } from '@/lib/desktop-shell'
import { sessionKey } from '@/lib/session-key'

export const UNREAD_STORAGE_KEY = 'oa.unread-sessions.v1'
/** The shell's event: a session was read in the notch, the pet or another window. */
export const SESSION_READ_EVENT = 'session-read'
const MAX_UNREAD = 200

interface UnreadState {
  /** Oldest first; capped so deleted sessions cannot pile up forever. */
  ids: string[]
  markUnread: (sessionId: string) => void
  /** Read here: cleared, and reported to the desktop shell. */
  markRead: (sessionId: string) => void
  /** Read elsewhere (the shell said so): cleared, not reported back. */
  applyRemoteRead: (sessionId: string) => void
}

/** Tell the desktop shell, which clears the notch, the pet and the other windows. */
function reportRead(sessionId: string): void {
  if (!isDesktopShell()) return
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('session_read', { sessionId }))
    .catch(() => {})
}

export const useUnreadStore = create<UnreadState>()(
  persist(
    (set, get) => ({
      ids: [],
      markUnread: (sessionId) => {
        if (get().ids.includes(sessionId)) return
        set({ ids: [...get().ids, sessionId].slice(-MAX_UNREAD) })
      },
      markRead: (sessionId) => {
        if (!get().ids.includes(sessionId)) return
        set({ ids: get().ids.filter((id) => id !== sessionId) })
        reportRead(sessionId)
      },
      applyRemoteRead: (sessionId) => {
        const key = sessionKey(sessionId)
        const ids = get().ids.filter((id) => sessionKey(id) !== key)
        if (ids.length !== get().ids.length) set({ ids })
      },
    }),
    {
      name: UNREAD_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ ids: state.ids }),
      merge: (persisted, current) => {
        const ids = (persisted as { ids?: unknown } | undefined)?.ids
        return Array.isArray(ids)
          ? { ...current, ids: ids.filter((id): id is string => typeof id === 'string') }
          : current
      },
    },
  ),
)

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === UNREAD_STORAGE_KEY) void useUnreadStore.persist.rehydrate()
  })
}

let stopSessionReadSync: (() => void) | null = null

/** Hear reads from the desktop shell. Install once at startup; a no-op elsewhere. */
export function installSessionReadSync(): () => void {
  if (stopSessionReadSync) return stopSessionReadSync
  if (typeof window === 'undefined' || !isDesktopShell()) return () => {}
  let stopped = false
  let unlisten: (() => void) | undefined
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<{ sessionId?: unknown }>(SESSION_READ_EVENT, ({ payload }) => {
      if (typeof payload?.sessionId === 'string') useUnreadStore.getState().applyRemoteRead(payload.sessionId)
    }))
    .then((stop) => {
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => {})
  stopSessionReadSync = () => {
    stopped = true
    unlisten?.()
    stopSessionReadSync = null
  }
  return stopSessionReadSync
}

/** Clears the unread mark of the session on screen, now and whenever it returns. */
export function useMarkSessionRead(sessionId: string | null | undefined): void {
  const unread = useUnreadStore((state) => (sessionId ? state.ids.includes(sessionId) : false))
  const visible = useDocumentVisible()

  useEffect(() => {
    if (sessionId && unread && visible) useUnreadStore.getState().markRead(sessionId)
  }, [sessionId, unread, visible])
}

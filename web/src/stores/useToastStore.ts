/**
 * Tiny client-state store for ephemeral toasts. Emits a short banner
 * (success / error / info) that auto-dismisses after `durationMs`. Lives
 * outside TanStack Query because toasts are UI-only, not server state.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  tone: ToastTone
  title: string
  description?: string
  /** Auto-dismiss delay; the ToastStack item owns the timer so it can
   * pause while the pointer/focus is on the toast. */
  durationMs?: number
}

interface ToastStore {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>, durationMs?: number) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastStore>()(
  immer((set) => ({
    toasts: [],
    push: (t, durationMs = 4500) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      // Auto-dismiss is owned by the ToastStack item (so it can pause on
      // hover/focus), driven by the durationMs stored on the toast.
      set((state) => {
        state.toasts.push({ id, ...t, durationMs })
      })
    },
    dismiss: (id) => {
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id)
      })
    },
  }))
)

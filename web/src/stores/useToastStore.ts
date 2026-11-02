/**
 * Tiny client-state store for toasts. Success and info banners close on
 * their own after `durationMs`; an error stays until the user closes it, so
 * it can't vanish before it's read. A toast may carry one action (Retry,
 * Undo…). Lives outside TanStack Query because toasts are UI-only.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  onAction: () => void
}

export interface Toast {
  id: string
  tone: ToastTone
  title: string
  description?: string
  /** One button beside the text; running it closes the toast. */
  action?: ToastAction
  /** Auto-dismiss delay, or null to stay until closed. The ToastStack item
   * owns the timer so it can pause while the pointer/focus is on it. */
  durationMs?: number | null
}

interface ToastStore {
  toasts: Toast[]
  /** Returns the toast id, so a caller can close it early. */
  push: (t: Omit<Toast, 'id'>, durationMs?: number | null) => string
  dismiss: (id: string) => void
}

const DEFAULT_DURATION_MS = 4500

export const useToastStore = create<ToastStore>()(
  immer((set) => ({
    toasts: [],
    push: (t, durationMs) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const duration = durationMs !== undefined
        ? durationMs
        : t.durationMs !== undefined ? t.durationMs : t.tone === 'error' ? null : DEFAULT_DURATION_MS
      set((state) => {
        state.toasts.push({ id, ...t, durationMs: duration })
      })
      return id
    },
    dismiss: (id) => {
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id)
      })
    },
  }))
)

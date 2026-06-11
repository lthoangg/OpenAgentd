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
}

interface ToastStore {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>, durationMs?: number) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastStore>()(
  immer((set, get) => ({
    toasts: [],
    push: (t, durationMs = 4500) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      set((state) => {
        state.toasts.push({ id, ...t })
      })
      setTimeout(() => get().dismiss(id), durationMs)
    },
    dismiss: (id) => {
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id)
      })
    },
  }))
)

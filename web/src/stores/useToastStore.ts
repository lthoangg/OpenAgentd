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

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useToastStore = create<ToastStore>()(
  immer((set, get) => ({
    toasts: [],
    push: (t, durationMs = 4500) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      set((state) => {
        state.toasts.push({ id, ...t })
      })
      const timer = setTimeout(() => {
        toastTimers.delete(id)
        get().dismiss(id)
      }, durationMs)
      toastTimers.set(id, timer)
    },
    dismiss: (id) => {
      const timer = toastTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        toastTimers.delete(id)
      }
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id)
      })
    },
  }))
)

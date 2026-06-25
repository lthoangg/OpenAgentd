/**
 * useUIStore — tiny client-state store for UI panels that live above the
 * TeamChatView and were previously owned by ``Sidebar``. Lifting state to a
 * shared store lets shortcuts and command palette items coordinate modal
 * visibility from one path.
 *
 * Mirrors the size and shape of ``useToastStore`` — Zustand + immer, no
 * persistence, no derived selectors.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

interface UIStore {
  schedulerOpen: boolean
  agentCapabilitiesOpen: boolean
  toggleScheduler: () => void
  toggleAgentCapabilities: () => void
  closeScheduler: () => void
  closeAgentCapabilities: () => void
}

export const useUIStore = create<UIStore>()(
  immer((set) => ({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    toggleScheduler: () => set((state) => {
      const nextOpen = !state.schedulerOpen
      state.schedulerOpen = nextOpen
      if (nextOpen) {
        state.agentCapabilitiesOpen = false
      }
    }),
    toggleAgentCapabilities: () => set((state) => {
      const nextOpen = !state.agentCapabilitiesOpen
      state.agentCapabilitiesOpen = nextOpen
      if (nextOpen) {
        state.schedulerOpen = false
      }
    }),
    closeScheduler: () => set((state) => { state.schedulerOpen = false }),
    closeAgentCapabilities: () => set((state) => { state.agentCapabilitiesOpen = false }),
  }))
)

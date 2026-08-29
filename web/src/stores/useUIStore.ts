/**
 * useUIStore — tiny client-state store for UI panels that live above the
 * AgentChatView and were previously owned by ``Sidebar``. Lifting state to a
 * shared store lets shortcuts and command palette items coordinate modal
 * visibility from one path.
 *
 * Mirrors the size and shape of ``useToastStore`` — Zustand + immer, no
 * persistence, no derived selectors.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

/**
 * Weak back-reference to closeSettings, set by useSettingsStore at module
 * init to avoid a circular import. UIStore is the lower-level store; it
 * cannot import useSettingsStore directly.
 */
let _closeSettings: (() => void) | null = null
export function _registerCloseSettings(fn: () => void): void {
  _closeSettings = fn
}

interface UIStore {
  schedulerOpen: boolean
  agentCapabilitiesOpen: boolean
  paletteOpen: boolean
  quickOpenOpen: boolean
  toggleScheduler: () => void
  toggleAgentCapabilities: () => void
  togglePalette: () => void
  toggleQuickOpen: () => void
  closeScheduler: () => void
  closeAgentCapabilities: () => void
  closePalette: () => void
  closeQuickOpen: () => void
  closeAll: () => void
}

export const useUIStore = create<UIStore>()(
  immer((set) => ({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
    quickOpenOpen: false,
    toggleScheduler: () => {
      set((state) => {
        const nextOpen = !state.schedulerOpen
        state.schedulerOpen = nextOpen
        if (nextOpen) {
          state.agentCapabilitiesOpen = false
          state.paletteOpen = false
          state.quickOpenOpen = false
        }
      })
      if (useUIStore.getState().schedulerOpen) _closeSettings?.()
    },
    toggleAgentCapabilities: () => {
      set((state) => {
        const nextOpen = !state.agentCapabilitiesOpen
        state.agentCapabilitiesOpen = nextOpen
        if (nextOpen) {
          state.schedulerOpen = false
          state.paletteOpen = false
          state.quickOpenOpen = false
        }
      })
      if (useUIStore.getState().agentCapabilitiesOpen) _closeSettings?.()
    },
    togglePalette: () => {
      set((state) => {
        const nextOpen = !state.paletteOpen
        state.paletteOpen = nextOpen
        if (nextOpen) {
          state.schedulerOpen = false
          state.agentCapabilitiesOpen = false
          state.quickOpenOpen = false
        }
      })
      if (useUIStore.getState().paletteOpen) _closeSettings?.()
    },
    toggleQuickOpen: () => {
      set((state) => {
        const nextOpen = !state.quickOpenOpen
        state.quickOpenOpen = nextOpen
        if (nextOpen) {
          state.schedulerOpen = false
          state.agentCapabilitiesOpen = false
          state.paletteOpen = false
        }
      })
      if (useUIStore.getState().quickOpenOpen) _closeSettings?.()
    },
    closeScheduler: () => set((state) => { state.schedulerOpen = false }),
    closeAgentCapabilities: () => set((state) => { state.agentCapabilitiesOpen = false }),
    closePalette: () => set((state) => { state.paletteOpen = false }),
    closeQuickOpen: () => set((state) => { state.quickOpenOpen = false }),
    closeAll: () => set((state) => {
      state.schedulerOpen = false
      state.agentCapabilitiesOpen = false
      state.paletteOpen = false
      state.quickOpenOpen = false
    }),
  }))
)

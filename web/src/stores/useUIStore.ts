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
  /** Ids of the palette pages it opens on, outermost first; empty for the root list. */
  palettePage: string[]
  /** Bumped when the palette opens at a page, so an open palette remounts there. */
  paletteKey: number
  quickOpenOpen: boolean
  /** What Quick Open searches for as it opens; empty from its shortcut. */
  quickOpenQuery: string
  /** Telemetry overlay (mounted at the app root, reachable from any route). */
  telemetryOpen: boolean
  /** Keyboard Shortcuts sheet (app root). */
  shortcutsHelpOpen: boolean
  /** Task the scheduler should open on next (a sidebar click); taken once. */
  scheduledTaskFocus: string | null
  focusScheduledTask: (taskId: string | null) => void
  toggleScheduler: () => void
  toggleAgentCapabilities: () => void
  togglePalette: () => void
  /**
   * Open the palette on a page (Switch Workspace/Session…, or a workspace's
   * sessions). Closes it when it is already open on that page.
   */
  openPaletteAt: (page: string[]) => void
  toggleQuickOpen: () => void
  /** Open Quick Open already searching, e.g. for a file reference that matched several files. */
  openQuickOpen: (query: string) => void
  openTelemetry: () => void
  toggleTelemetry: () => void
  toggleShortcutsHelp: () => void
  closeShortcutsHelp: () => void
  closeScheduler: () => void
  closeAgentCapabilities: () => void
  closePalette: () => void
  closeQuickOpen: () => void
  closeTelemetry: () => void
  closeAll: () => void
}

export const useUIStore = create<UIStore>()(
  immer((set, get) => ({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
    palettePage: [],
    paletteKey: 0,
    quickOpenOpen: false,
    quickOpenQuery: '',
    telemetryOpen: false,
    shortcutsHelpOpen: false,
    scheduledTaskFocus: null,
    focusScheduledTask: (taskId) => set((state) => { state.scheduledTaskFocus = taskId }),
    toggleScheduler: () => {
      set((state) => {
        const nextOpen = !state.schedulerOpen
        state.schedulerOpen = nextOpen
        if (nextOpen) {
          state.agentCapabilitiesOpen = false
          state.paletteOpen = false
          state.quickOpenOpen = false
          state.telemetryOpen = false
          state.shortcutsHelpOpen = false
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
          state.telemetryOpen = false
          state.shortcutsHelpOpen = false
        }
      })
      if (useUIStore.getState().agentCapabilitiesOpen) _closeSettings?.()
    },
    togglePalette: () => {
      set((state) => {
        const nextOpen = !state.paletteOpen
        state.paletteOpen = nextOpen
        if (nextOpen) {
          state.palettePage = []
          state.schedulerOpen = false
          state.agentCapabilitiesOpen = false
          state.quickOpenOpen = false
          state.telemetryOpen = false
          state.shortcutsHelpOpen = false
        }
      })
      if (useUIStore.getState().paletteOpen) _closeSettings?.()
    },
    openPaletteAt: (page) => {
      set((state) => {
        const samePage = state.palettePage.length === page.length && state.palettePage.every((id, i) => id === page[i])
        if (state.paletteOpen && samePage) {
          state.paletteOpen = false
          return
        }
        state.paletteOpen = true
        state.palettePage = page
        state.paletteKey += 1
        state.schedulerOpen = false
        state.agentCapabilitiesOpen = false
        state.quickOpenOpen = false
        state.telemetryOpen = false
        state.shortcutsHelpOpen = false
      })
      if (useUIStore.getState().paletteOpen) _closeSettings?.()
    },
    toggleQuickOpen: () => {
      set((state) => {
        const nextOpen = !state.quickOpenOpen
        state.quickOpenOpen = nextOpen
        if (nextOpen) {
          state.quickOpenQuery = ''
          state.schedulerOpen = false
          state.agentCapabilitiesOpen = false
          state.paletteOpen = false
          state.telemetryOpen = false
          state.shortcutsHelpOpen = false
        }
      })
      if (useUIStore.getState().quickOpenOpen) _closeSettings?.()
    },
    openQuickOpen: (query) => {
      set((state) => {
        state.quickOpenOpen = true
        state.quickOpenQuery = query
        state.schedulerOpen = false
        state.agentCapabilitiesOpen = false
        state.paletteOpen = false
        state.telemetryOpen = false
        state.shortcutsHelpOpen = false
      })
      _closeSettings?.()
    },
    openTelemetry: () => {
      set((state) => {
        state.telemetryOpen = true
        state.schedulerOpen = false
        state.agentCapabilitiesOpen = false
        state.paletteOpen = false
        state.quickOpenOpen = false
        state.shortcutsHelpOpen = false
      })
      _closeSettings?.()
    },
    toggleTelemetry: () => {
      if (get().telemetryOpen) get().closeTelemetry()
      else get().openTelemetry()
    },
    toggleShortcutsHelp: () => {
      set((state) => {
        const nextOpen = !state.shortcutsHelpOpen
        state.shortcutsHelpOpen = nextOpen
        if (nextOpen) {
          state.schedulerOpen = false
          state.agentCapabilitiesOpen = false
          state.paletteOpen = false
          state.quickOpenOpen = false
          state.telemetryOpen = false
        }
      })
      if (useUIStore.getState().shortcutsHelpOpen) _closeSettings?.()
    },
    closeShortcutsHelp: () => set((state) => { state.shortcutsHelpOpen = false }),
    closeScheduler: () => set((state) => { state.schedulerOpen = false }),
    closeAgentCapabilities: () => set((state) => { state.agentCapabilitiesOpen = false }),
    closePalette: () => set((state) => { state.paletteOpen = false }),
    closeQuickOpen: () => set((state) => { state.quickOpenOpen = false }),
    closeTelemetry: () => set((state) => { state.telemetryOpen = false }),
    closeAll: () => set((state) => {
      state.schedulerOpen = false
      state.agentCapabilitiesOpen = false
      state.paletteOpen = false
      state.quickOpenOpen = false
      state.telemetryOpen = false
      state.shortcutsHelpOpen = false
    }),
  }))
)

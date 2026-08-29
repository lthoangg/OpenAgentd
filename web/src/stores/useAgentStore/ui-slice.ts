import type { StateCreator } from 'zustand'
import type { AgentStore } from './types'

export type UISlice = Pick<AgentStore, 'sidebarOpen' | 'toggleSidebar'>

export const createUISlice: StateCreator<
  AgentStore,
  [['zustand/immer', never]],
  [],
  UISlice
> = (set) => ({
  sidebarOpen: false,

  toggleSidebar: () => {
    set((draft) => { draft.sidebarOpen = !draft.sidebarOpen })
  },
})

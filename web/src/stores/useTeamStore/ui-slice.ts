import type { StateCreator } from 'zustand'
import type { TeamStore } from './types'

export type UISlice = Pick<TeamStore, 'sidebarOpen' | 'toggleSidebar'>

export const createUISlice: StateCreator<
  TeamStore,
  [['zustand/immer', never]],
  [],
  UISlice
> = (set) => ({
  sidebarOpen: false,

  toggleSidebar: () => {
    set((draft) => { draft.sidebarOpen = !draft.sidebarOpen })
  },
})

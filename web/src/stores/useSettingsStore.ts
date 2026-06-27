/**
 * useSettingsStore — controls the VS Code–style settings modal.
 *
 * Navigation is self-contained: section + optional selectedName covers
 * all views (list, new-form, editor). No URL changes happen.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { useUIStore, _registerCloseSettings } from './useUIStore'

export type SettingsSection =
  | 'about'
  | 'agents'
  | 'agents-new'
  | 'agents-edit'
  | 'skills'
  | 'skills-new'
  | 'skills-edit'
  | 'mcp'
  | 'mcp-new'
  | 'mcp-edit'
  | 'providers'
  | 'sandbox'
  | 'multimodal'
  | 'title-generation'
  | 'notifications'

interface SettingsStore {
  open: boolean
  section: SettingsSection
  /** Name param for editor views (agents-edit, skills-edit, mcp-edit). */
  selectedName: string | null
  openSettings: (section?: SettingsSection, name?: string | null) => void
  setSection: (section: SettingsSection, name?: string | null) => void
  closeSettings: () => void
}

export const useSettingsStore = create<SettingsStore>()(
  immer((set) => {
    // Register closeSettings with UIStore so its toggle actions can close
    // the settings modal without creating a circular import.
    _registerCloseSettings(() => useSettingsStore.getState().closeSettings())

    return {
    open: false,
    section: 'about',
    selectedName: null,
    openSettings: (section = 'about', name = null) => {
      useUIStore.getState().closeAll()
      set((state) => {
        state.open = true
        state.section = section
        state.selectedName = name ?? null
      })
    },
    setSection: (section, name = null) =>
      set((state) => {
        state.section = section
        state.selectedName = name ?? null
      }),
    closeSettings: () =>
      set((state) => {
        state.open = false
      }),
    }
  }),
)

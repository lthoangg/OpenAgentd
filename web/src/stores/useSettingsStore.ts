/**
 * useSettingsStore — controls the VS Code–style settings modal.
 *
 * Navigation is self-contained: section + optional selectedName covers
 * the skill and MCP drill-down editors. The coding agent is a fixed editor.
 *
 * The last visited section is persisted, so reopening settings returns you
 * where you left off instead of resetting to About every time. Drill-down
 * views are collapsed to their parent list on rehydrate, because the item they
 * pointed at (a skill or MCP server) may since have been deleted.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { useUIStore, _registerCloseSettings } from './useUIStore'

export type SettingsSection =
  | 'about'
  | 'agents'
  | 'skills'
  | 'skills-new'
  | 'skills-edit'
  | 'mcp'
  | 'mcp-new'
  | 'mcp-edit'
  | 'providers'
  | 'denied_paths'
  | 'sandbox'
  // Replaced the former 'multimodal' | 'summarization' | 'title-generation'
  // sections, which are now collapsible groups on one Automation page.
  | 'automation'

/**
 * Sections that are lists with `-new` / `-edit` drill-down views. Declared here
 * next to the union it describes, so the store and the section registry share
 * one definition instead of both hardcoding the same three prefixes.
 */
const DRILL_DOWN_FAMILIES = ['skills', 'mcp'] as const

/**
 * Collapses a drill-down section to the list it belongs to. Used for restoring
 * persisted state (`agents-edit` without a valid `selectedName` would render an
 * empty pane) and for sidebar highlighting.
 */
export function parentSection(section: SettingsSection): SettingsSection {
  // Settings state is persisted without schema validation. Treat sections
  // removed in older builds as About so an upgrade cannot reopen a dead page.
  const persistedSection = section as string
  if (persistedSection === 'notifications' || persistedSection === 'terminal') {
    return 'about'
  }
  return DRILL_DOWN_FAMILIES.find((f) => section.startsWith(f)) ?? section
}

interface SettingsStore {
  open: boolean
  section: SettingsSection
  /** Name param for editor views (skills-edit, mcp-edit). */
  selectedName: string | null
  /**
   * Opens the modal. Omit `section` to resume the last visited one; pass it
   * explicitly to jump somewhere specific (e.g. `openSettings('providers')`
   * from the missing-credentials prompt).
   */
  openSettings: (section?: SettingsSection, name?: string | null) => void
  setSection: (section: SettingsSection, name?: string | null) => void
  closeSettings: () => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    immer((set) => {
      // Register closeSettings with UIStore so its toggle actions can close
      // the settings modal without creating a circular import.
      _registerCloseSettings(() => useSettingsStore.getState().closeSettings())

      return {
        open: false,
        section: 'about',
        selectedName: null,
        openSettings: (section, name = null) => {
          useUIStore.getState().closeAll()
          set((state) => {
            state.open = true
            // `undefined` means "resume where the user left off".
            if (section !== undefined) {
              state.section = section
              state.selectedName = name ?? null
            }
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
    {
      name: 'oa.settingsStore',
      // `open` is deliberately excluded: the modal should never reappear on
      // its own after a reload.
      partialize: (state) => ({ section: parentSection(state.section) }),
    },
  ),
)

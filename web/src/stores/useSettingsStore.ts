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
  | 'general'
  | 'desktop'
  | 'connection'
  | 'account'
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
  | 'memory'
  | 'telemetry'
  | 'plugins'
  // The former Automation page, split into one page per job.
  | 'workspaces'
  | 'goals'
  | 'titles'
  | 'context'
  | 'media'

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
  return DRILL_DOWN_FAMILIES.find((f) => section.startsWith(f)) ?? section
}

/**
 * Pages that are now headings of Sessions (section id ``titles``). Their ids
 * still open: on Sessions, scrolled to the heading.
 */
const MERGED_INTO_SESSIONS: Partial<Record<SettingsSection, string>> = {
  context: 'Summaries',
  goals: 'Goals',
  telemetry: 'History',
}

/** The page a section id opens, and the heading on it to scroll to, if any. */
export function resolveSection(section: SettingsSection): { section: SettingsSection; anchor: string | null } {
  const anchor = MERGED_INTO_SESSIONS[section]
  return anchor ? { section: 'titles', anchor } : { section, anchor: null }
}

interface SettingsStore {
  open: boolean
  dirtyDrafts: Record<string, boolean>
  pendingNavigation: { section?: SettingsSection; name?: string | null; close?: boolean; index?: boolean } | null
  setDraftDirty: (id: string, dirty: boolean) => void
  resolvePendingNavigation: (discard: boolean) => void
  section: SettingsSection
  /** Name param for editor views (skills-edit, mcp-edit). */
  selectedName: string | null
  /** A heading on the page to scroll to once it has rendered (a merged section id). Not persisted. */
  anchor: string | null
  /**
   * Phones show either the grouped section list (`index`) or one section
   * full-screen. Desktop always shows sidebar + section and ignores this.
   * Not persisted: reopening without a target always starts at the list.
   */
  mobileView: 'index' | 'section'
  /**
   * Opens the modal. Omit `section` to resume the last visited one; pass it
   * explicitly to jump somewhere specific (e.g. `openSettings('providers')`
   * from the missing-credentials prompt). On phones, omitting it opens the
   * section list; passing it opens that section directly.
   */
  openSettings: (section?: SettingsSection, name?: string | null) => void
  setSection: (section: SettingsSection, name?: string | null) => void
  /** Phones: back to the section list, guarded by the unsaved-changes prompt. */
  showIndex: () => void
  closeSettings: () => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    immer((set, get) => {
      // Register closeSettings with UIStore so its toggle actions can close
      // the settings modal without creating a circular import.
      _registerCloseSettings(() => useSettingsStore.getState().closeSettings())

      return {
        open: false,
        dirtyDrafts: {},
        pendingNavigation: null,
        setDraftDirty: (id, dirty) => set((state) => {
          if (dirty) state.dirtyDrafts[id] = true
          else delete state.dirtyDrafts[id]
        }),
        resolvePendingNavigation: (discard) => set((state) => {
          const pending = state.pendingNavigation
          state.pendingNavigation = null
          if (!discard || !pending) return
          state.dirtyDrafts = {}
          if (pending.close) state.open = false
          else if (pending.index) state.mobileView = 'index'
          else if (pending.section) {
            const target = resolveSection(pending.section)
            state.section = target.section
            state.anchor = target.anchor
            state.selectedName = pending.name ?? null
            state.mobileView = 'section'
          }
        }),
        section: 'general',
        selectedName: null,
        anchor: null,
        mobileView: 'index',
        openSettings: (section, name = null) => {
          if (get().open && section !== undefined && Object.keys(get().dirtyDrafts).length) {
            get().setSection(section, name)
            return
          }
          useUIStore.getState().closeAll()
          set((state) => {
            state.open = true
            // `undefined` means "resume where the user left off".
            if (section !== undefined) {
              const target = resolveSection(section)
              state.section = target.section
              state.anchor = target.anchor
              state.selectedName = name ?? null
              state.mobileView = 'section'
            } else {
              state.mobileView = 'index'
            }
          })
        },
        setSection: (requested, name = null) =>
          set((state) => {
            const { section, anchor } = resolveSection(requested)
            if (section === state.section && name === state.selectedName) {
              state.mobileView = 'section'
              state.anchor = anchor
              return
            }
            if (Object.keys(state.dirtyDrafts).length) {
              state.pendingNavigation = { section: requested, name }
              return
            }
            state.section = section
            state.anchor = anchor
            state.selectedName = name ?? null
            state.mobileView = 'section'
          }),
        showIndex: () =>
          set((state) => {
            if (state.mobileView === 'index') return
            if (Object.keys(state.dirtyDrafts).length) {
              state.pendingNavigation = { index: true }
              return
            }
            state.mobileView = 'index'
          }),
        closeSettings: () =>
          set((state) => {
            if (Object.keys(state.dirtyDrafts).length) {
              state.pendingNavigation = { close: true }
              return
            }
            state.open = false
          }),
      }
    }),
    {
      name: 'oa.settingsStore',
      // `open` is deliberately excluded: the modal should never reappear on
      // its own after a reload.
      partialize: (state) => ({ section: parentSection(state.section) }),
      // A section saved by a version that still had the merged pages.
      merge: (persisted, current) => {
        const saved = (persisted as { section?: SettingsSection } | undefined)?.section
        return saved ? { ...current, section: resolveSection(saved).section } : current
      },
    },
  ),
)

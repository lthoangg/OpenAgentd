/**
 * useSidebarViewStore — the sidebar's View options, persisted per device.
 *
 * ``groupBy`` picks the shape of the session list: the workspace tree
 * (``project``) or one flat list across workspaces grouped by status, by
 * date, or not at all. ``sortBy`` orders sessions within each group.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SessionSort } from '@/api/types'

export const SIDEBAR_VIEW_STORAGE_KEY = 'oa.sidebarView.v1'

export type SidebarGroupBy = 'project' | 'status' | 'date' | 'none'

export const SIDEBAR_GROUP_BY: readonly { value: SidebarGroupBy; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'status', label: 'Status' },
  { value: 'date', label: 'Date' },
  { value: 'none', label: 'None' },
]

export const SIDEBAR_SORT_BY: readonly { value: SessionSort; label: string }[] = [
  { value: 'activity', label: 'Recent activity' },
  { value: 'created', label: 'Created' },
]

interface SidebarViewPrefs {
  groupBy: SidebarGroupBy
  sortBy: SessionSort
  showDetails: boolean
  /** The Pinned section is folded. */
  pinnedCollapsed: boolean
  /** Folded groups of the flat views, by group id. */
  collapsedGroups: readonly string[]
}

interface SidebarViewState extends SidebarViewPrefs {
  setGroupBy: (groupBy: SidebarGroupBy) => void
  setSortBy: (sortBy: SessionSort) => void
  setShowDetails: (showDetails: boolean) => void
  setPinnedCollapsed: (collapsed: boolean) => void
  toggleGroupCollapsed: (group: string) => void
  /** Back to the default view (folding state is kept). */
  reset: () => void
}

export const SIDEBAR_VIEW_DEFAULTS: Pick<SidebarViewPrefs, 'groupBy' | 'sortBy' | 'showDetails'> = {
  groupBy: 'project',
  sortBy: 'activity',
  showDetails: true,
}

function isGroupBy(value: unknown): value is SidebarGroupBy {
  return SIDEBAR_GROUP_BY.some((option) => option.value === value)
}

function isSortBy(value: unknown): value is SessionSort {
  return SIDEBAR_SORT_BY.some((option) => option.value === value)
}

export const useSidebarViewStore = create<SidebarViewState>()(
  persist(
    (set) => ({
      ...SIDEBAR_VIEW_DEFAULTS,
      pinnedCollapsed: false,
      collapsedGroups: [],
      setGroupBy: (groupBy) => set({ groupBy }),
      setSortBy: (sortBy) => set({ sortBy }),
      setShowDetails: (showDetails) => set({ showDetails }),
      setPinnedCollapsed: (pinnedCollapsed) => set({ pinnedCollapsed }),
      toggleGroupCollapsed: (group) =>
        set((state) => ({
          collapsedGroups: state.collapsedGroups.includes(group)
            ? state.collapsedGroups.filter((g) => g !== group)
            : [...state.collapsedGroups, group],
        })),
      reset: () => set({ ...SIDEBAR_VIEW_DEFAULTS }),
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ groupBy, sortBy, showDetails, pinnedCollapsed, collapsedGroups }) => ({
        groupBy,
        sortBy,
        showDetails,
        pinnedCollapsed,
        collapsedGroups,
      }),
      // Stored without a schema: a value from another build reads as the
      // default rather than as a sidebar that renders nothing.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Record<keyof SidebarViewPrefs, unknown>>
        return {
          ...current,
          groupBy: isGroupBy(p.groupBy) ? p.groupBy : SIDEBAR_VIEW_DEFAULTS.groupBy,
          sortBy: isSortBy(p.sortBy) ? p.sortBy : SIDEBAR_VIEW_DEFAULTS.sortBy,
          showDetails: typeof p.showDetails === 'boolean' ? p.showDetails : SIDEBAR_VIEW_DEFAULTS.showDetails,
          pinnedCollapsed: typeof p.pinnedCollapsed === 'boolean' ? p.pinnedCollapsed : false,
          collapsedGroups: Array.isArray(p.collapsedGroups) ? p.collapsedGroups.filter((g): g is string => typeof g === 'string') : [],
        }
      },
    },
  ),
)

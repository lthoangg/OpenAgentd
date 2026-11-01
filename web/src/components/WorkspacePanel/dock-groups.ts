/**
 * The Review panel's tab groups, as pure state transitions.
 *
 * One strip, or two stacked top/bottom (⌘\). Terminals open in the lower
 * group on desktop, so a diff and a shell show at once; ⌃` hides that group
 * without closing anything. Each group has at most one *preview* tab
 * (italic): opening another file or diff from the transcript or a list
 * replaces it, until it is kept (double-click, Keep Open, an edit). A strip
 * lists its views (Git, Plan, Tasks…) before its documents. Closing the last
 * tab of a group joins the groups again.
 *
 * ``useDockTabs`` holds this state; ``serializeDockGroups`` /
 * ``restoreDockGroups`` carry it across sessions (terminals belong to the
 * workspace, so they are re-adopted rather than saved).
 */
import { type DockTab, isViewTab, terminalTabId } from './dock-tabs'

export type GroupIndex = 0 | 1

export interface DockGroups {
  /** Every open tab, both groups. */
  tabs: DockTab[]
  /** Ids of the tabs in the lower group. */
  lower: string[]
  /** Active tab per group; ``''`` shows the launcher. */
  active: [string, string]
  /** The group keys and new tabs go to. */
  focused: GroupIndex
  /** Two groups (the lower one may be empty: it shows the launcher). */
  split: boolean
  /** The lower group is hidden (⌃`); its tabs and shells stay. */
  lowerHidden: boolean
  /** Each group's reusable preview tab. */
  preview: [string | null, string | null]
}

export const EMPTY_DOCK_GROUPS: DockGroups = {
  tabs: [],
  lower: [],
  active: ['', ''],
  focused: 0,
  split: false,
  lowerHidden: false,
  preview: [null, null],
}

function pair<T>(value: [T, T], group: GroupIndex, next: T): [T, T] {
  return group === 0 ? [next, value[1]] : [value[0], next]
}

export function groupOf(state: DockGroups, id: string): GroupIndex {
  return state.lower.includes(id) ? 1 : 0
}

/** A group's tabs in strip order: views first, then documents. */
export function groupTabs(state: DockGroups, group: GroupIndex): DockTab[] {
  const mine = state.tabs.filter((tab) => groupOf(state, tab.id) === group)
  return [...mine.filter(isViewTab), ...mine.filter((tab) => !isViewTab(tab))]
}

/** The lower group is on screen. */
export function lowerVisible(state: DockGroups): boolean {
  return state.split && !state.lowerHidden
}

function reveal(state: DockGroups, group: GroupIndex, id: string): DockGroups {
  return {
    ...state,
    active: pair(state.active, group, id),
    focused: group,
    ...(group === 1 ? { split: true, lowerHidden: false } : {}),
  }
}

export interface OpenTabOptions {
  /** Where a new tab goes (an open one stays in its group). Default: upper. */
  group?: GroupIndex
  /** Open as the group's preview tab, replacing the current one. */
  preview?: boolean
}

/**
 * Open ``tab``: an open one is updated in place and shown; a new one replaces
 * the group's preview tab (``preview``) or goes right after the group's
 * active tab (terminals at the end).
 */
export function openTab(state: DockGroups, tab: DockTab, { group = 0, preview = false }: OpenTabOptions = {}): DockGroups {
  const index = state.tabs.findIndex((item) => item.id === tab.id)
  if (index >= 0) {
    const at = groupOf(state, tab.id)
    const tabs = state.tabs.map((item, i) => (i === index ? tab : item))
    const previewIds = !preview && state.preview[at] === tab.id ? pair(state.preview, at, null) : state.preview
    return reveal({ ...state, tabs, preview: previewIds }, at, tab.id)
  }
  const replacing = preview ? state.preview[group] : null
  let tabs: DockTab[]
  let lower = state.lower
  if (replacing && state.tabs.some((item) => item.id === replacing)) {
    tabs = state.tabs.map((item) => (item.id === replacing ? tab : item))
    lower = lower.map((id) => (id === replacing ? tab.id : id))
  } else {
    const after = tab.type === 'terminal' ? -1 : state.tabs.findIndex((item) => item.id === state.active[group])
    tabs = after < 0 ? [...state.tabs, tab] : [...state.tabs.slice(0, after + 1), tab, ...state.tabs.slice(after + 1)]
    if (group === 1) lower = [...lower, tab.id]
  }
  const previewIds = preview ? pair(state.preview, group, tab.id) : state.preview
  return reveal({ ...state, tabs, lower, preview: previewIds }, group, tab.id)
}

/** Keep a preview tab: the next preview opens beside it. */
export function keepTab(state: DockGroups, id: string): DockGroups {
  const at = groupOf(state, id)
  return state.preview[at] === id ? { ...state, preview: pair(state.preview, at, null) } : state
}

export function activateTab(state: DockGroups, id: string): DockGroups {
  return reveal(state, groupOf(state, id), id)
}

/** The tab shown when ``id`` closes: its right neighbour, else its left. */
function neighbour(strip: DockTab[], id: string, closing: Set<string>): string {
  const index = strip.findIndex((tab) => tab.id === id)
  const right = strip.slice(index + 1).find((tab) => !closing.has(tab.id))
  const left = strip.slice(0, Math.max(0, index)).reverse().find((tab) => !closing.has(tab.id))
  return (right ?? left)?.id ?? ''
}

/** Join the groups: the lower tabs follow the upper ones in one strip. */
function join(state: DockGroups, active: string): DockGroups {
  const lower = new Set(state.lower)
  return {
    ...state,
    tabs: [...state.tabs.filter((tab) => !lower.has(tab.id)), ...state.tabs.filter((tab) => lower.has(tab.id))],
    lower: [],
    active: [active, ''],
    focused: 0,
    split: false,
    lowerHidden: false,
    preview: [state.preview[0] ?? state.preview[1], null],
  }
}

export function closeTabs(state: DockGroups, ids: readonly string[]): DockGroups {
  const closing = new Set(ids)
  if (closing.size === 0) return state
  const strips: [DockTab[], DockTab[]] = [groupTabs(state, 0), groupTabs(state, 1)]
  const active: [string, string] = [0, 1].map((g) => {
    const current = state.active[g]
    return closing.has(current) ? neighbour(strips[g], current, closing) : current
  }) as [string, string]
  const next: DockGroups = {
    ...state,
    tabs: state.tabs.filter((tab) => !closing.has(tab.id)),
    lower: state.lower.filter((id) => !closing.has(id)),
    active,
    preview: [0, 1].map((g) => (closing.has(state.preview[g] ?? '') ? null : state.preview[g])) as [string | null, string | null],
  }
  if (!state.split) return next
  const upperLeft = groupTabs(next, 0).length
  const lowerLeft = groupTabs(next, 1).length
  const upperClosed = strips[0].length > 0 && upperLeft === 0
  const lowerClosed = strips[1].length > 0 && lowerLeft === 0
  if (upperLeft === 0 && lowerLeft === 0) return { ...next, split: false, lowerHidden: false, focused: 0, active: ['', ''] }
  if (lowerClosed) return { ...next, split: false, lowerHidden: false, focused: 0, active: [next.active[0], ''] }
  if (upperClosed) return join(next, next.active[1])
  return next
}

/** ⌘\: split into an empty lower group, or join the two. */
export function toggleSplit(state: DockGroups): DockGroups {
  if (state.split) return join(state, state.active[state.focused] || state.active[0] || state.active[1])
  return { ...state, split: true, lowerHidden: false, focused: 1, active: [state.active[0], ''] }
}

/** ⌃`: hide the lower group, or show it (splitting if need be). */
export function toggleLowerGroup(state: DockGroups): DockGroups {
  if (lowerVisible(state)) return { ...state, lowerHidden: true, focused: 0 }
  return { ...state, split: true, lowerHidden: false, focused: 1 }
}

/** A tab can move only if its group keeps another tab. */
export function canMoveToOtherGroup(state: DockGroups, id: string): boolean {
  return groupTabs(state, groupOf(state, id)).length > 1
}

/** Move a tab to the end of the other group, splitting if need be. */
export function moveToOtherGroup(state: DockGroups, id: string): DockGroups {
  const tab = state.tabs.find((item) => item.id === id)
  if (!tab || !canMoveToOtherGroup(state, id)) return state
  const from = groupOf(state, id)
  const to: GroupIndex = from === 0 ? 1 : 0
  const sourceActive = state.active[from] === id ? neighbour(groupTabs(state, from), id, new Set([id])) : state.active[from]
  return {
    ...state,
    tabs: [...state.tabs.filter((item) => item.id !== id), tab],
    lower: to === 1 ? [...state.lower, id] : state.lower.filter((item) => item !== id),
    active: pair(pair(state.active, from, sourceActive), to, id),
    focused: to,
    split: true,
    lowerHidden: to === 1 ? false : state.lowerHidden,
    // Moving a tab is a choice to keep it.
    preview: pair(state.preview, from, state.preview[from] === id ? null : state.preview[from]),
  }
}

/**
 * Move a tab to ``toIndex`` of its strip (drag, ⌥⇧←/→, the tab menu). Views
 * stay before documents, so the index is kept within the tab's own kind.
 */
export function moveWithinGroup(state: DockGroups, id: string, toIndex: number): DockGroups {
  const group = groupOf(state, id)
  const strip = groupTabs(state, group)
  const from = strip.findIndex((tab) => tab.id === id)
  if (from < 0) return state
  const views = strip.filter(isViewTab).length
  const [min, max] = isViewTab(strip[from]) ? [0, views - 1] : [views, strip.length - 1]
  const to = Math.max(min, Math.min(max, toIndex))
  if (to === from) return state
  const order = [...strip]
  const [tab] = order.splice(from, 1)
  order.splice(to, 0, tab)
  const other = groupTabs(state, group === 0 ? 1 : 0)
  return { ...state, tabs: group === 0 ? [...order, ...other] : [...other, ...order] }
}

export interface TerminalInfo {
  id: string
  title: string
}

/**
 * Keep terminal tabs in step with the workspace's shells without moving
 * them: ended ones drop out, renamed ones update, new ones join the end of
 * the lower group (``intoLower``, desktop) or the one strip.
 */
export function syncTerminalTabs(state: DockGroups, terminals: readonly TerminalInfo[], intoLower: boolean): DockGroups {
  const live = new Map(terminals.map((meta) => [meta.id, meta]))
  let changed = false
  const gone: string[] = []
  const tabs = state.tabs.map((tab) => {
    if (tab.type !== 'terminal') return tab
    const meta = live.get(tab.termId)
    if (!meta) {
      gone.push(tab.id)
      return tab
    }
    if (meta.title !== tab.title) {
      changed = true
      return { ...tab, title: meta.title }
    }
    return tab
  })
  const present = new Set(tabs.map((tab) => (tab.type === 'terminal' ? tab.termId : null)))
  const added: DockTab[] = terminals
    .filter((meta) => !present.has(meta.id))
    .map((meta) => ({ id: terminalTabId(meta.id), type: 'terminal', title: meta.title, termId: meta.id }))
  if (!changed && added.length === 0 && gone.length === 0) return state
  let next: DockGroups = { ...state, tabs: [...tabs, ...added] }
  if (added.length > 0 && intoLower) {
    next = { ...next, lower: [...next.lower, ...added.map((tab) => tab.id)], split: true }
    if (!next.active[1]) next = { ...next, active: [next.active[0], added[0].id] }
  }
  return gone.length > 0 ? closeTabs(next, gone) : next
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Tabs that are saved with a session: not shells (the workspace's) or uploads. */
function savable(tab: DockTab): boolean {
  return tab.type !== 'terminal' && tab.type !== 'attachment'
}

export interface SavedDockGroups {
  tabs: DockTab[]
  lower: string[]
  active: [string, string]
  focused: GroupIndex
  split: boolean
  lowerHidden: boolean
  preview: [string | null, string | null]
}

export function serializeDockGroups(state: DockGroups): SavedDockGroups {
  const tabs = state.tabs.filter(savable).map((tab) => (tab.type === 'preview' ? { ...tab, navKey: 0 } : tab))
  const kept = new Set(tabs.map((tab) => tab.id))
  return {
    tabs,
    lower: state.lower.filter((id) => kept.has(id)),
    // A terminal can stay active: it is re-adopted from the workspace.
    active: state.active,
    focused: state.focused,
    split: state.split,
    lowerHidden: state.lowerHidden,
    preview: state.preview.map((id) => (id && kept.has(id) ? id : null)) as [string | null, string | null],
  }
}

function isTab(value: unknown): value is DockTab {
  return typeof value === 'object' && value !== null && typeof (value as DockTab).id === 'string' && typeof (value as DockTab).type === 'string'
}

/** A saved state, or ``null`` when it is missing or unreadable. */
export function restoreDockGroups(saved: unknown): DockGroups | null {
  if (typeof saved !== 'object' || saved === null) return null
  const value = saved as Partial<SavedDockGroups>
  if (!Array.isArray(value.tabs) || !value.tabs.every(isTab)) return null
  const ids = new Set(value.tabs.map((tab) => tab.id))
  const lower = Array.isArray(value.lower) ? value.lower.filter((id) => typeof id === 'string' && ids.has(id)) : []
  const active = Array.isArray(value.active) && value.active.length === 2 && value.active.every((id) => typeof id === 'string')
    ? value.active as [string, string]
    : ['', ''] as [string, string]
  const preview = (Array.isArray(value.preview) ? value.preview : [null, null])
    .map((id) => (typeof id === 'string' && ids.has(id) ? id : null)) as [string | null, string | null]
  const split = value.split === true
  return {
    tabs: value.tabs,
    lower: split ? lower : [],
    active,
    focused: value.focused === 1 && split ? 1 : 0,
    split,
    lowerHidden: split && value.lowerHidden === true,
    preview,
  }
}

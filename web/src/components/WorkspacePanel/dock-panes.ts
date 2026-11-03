/**
 * The Review panel's panes, as pure state transitions.
 *
 * Editor style: any number of panes, each with its own tab
 * strip, laid out as a tree of rows and columns. ⌘\ splits the focused pane
 * to the right and ⌘⇧\ down, as often as there is room; a tab dropped on a
 * pane's edge splits that pane, on its strip or its middle moves there.
 * Closing a pane's last tab closes the pane, and its room goes to the
 * neighbour before it (else the one after).
 * Closing the open tab shows the tab used before it in that pane, else
 * its right neighbour; that history (``recent``) lasts for the session only.
 *
 * Terminals are tabs like any other: they open in the focused pane, and a
 * split puts a shell beside a diff. Files, diffs and views opened from the
 * transcript or a list go to the focused pane too. Each pane has at most one
 * *preview* tab (italic): opening another file or diff there replaces it,
 * until it is kept (double-click, Keep Open, an edit, a move). A strip lists
 * its views (Git, Plan, Tasks…) before its documents.
 *
 * ``useDockTabs`` holds this state; ``serializeDockPanes`` /
 * ``restoreDockPanes`` carry it across sessions (a save from the two-group
 * panel restores as two stacked panes).
 */
import { type DockTab, isViewTab, terminalTabId } from './dock-tabs'

export type PaneId = string
/** ``row``: side by side. ``column``: stacked. */
export type Axis = 'row' | 'column'
export type SplitSide = 'left' | 'right' | 'up' | 'down'

export type PaneLayout =
  | { pane: PaneId }
  | { axis: Axis; children: PaneLayout[]; sizes: number[] }

export interface Pane {
  /** Tab ids (``paneTabs`` reads them views first). */
  tabs: string[]
  /** The tab on show; ``''`` shows the launcher. */
  active: string
  /** The pane's reusable preview tab. */
  preview: string | null
}

export interface DockPanes {
  /** Every open tab, in any pane. */
  tabs: DockTab[]
  panes: Record<PaneId, Pane>
  layout: PaneLayout
  /** The pane keys act on and documents open in. */
  focused: PaneId
  /** Tab ids, the latest shown first: which tab a close goes back to. Not saved. */
  recent?: string[]
}

const FIRST_PANE: PaneId = 'p1'
/** A save from the two-group panel: the upper pane's share of the height. */
export const UPPER_SHARE = 0.55
/** Enough history for any strip; older entries drop off. */
const RECENT_LIMIT = 50

function emptyPane(): Pane {
  return { tabs: [], active: '', preview: null }
}

export const EMPTY_DOCK_PANES: DockPanes = {
  tabs: [],
  panes: { [FIRST_PANE]: emptyPane() },
  layout: { pane: FIRST_PANE },
  focused: FIRST_PANE,
}

// ── Reading ─────────────────────────────────────────────────────────────────

export function isPaneLeaf(node: PaneLayout): node is { pane: PaneId } {
  return 'pane' in node
}

/** Every pane of ``node``, left to right and top to bottom. */
export function paneOrder(node: PaneLayout): PaneId[] {
  return isPaneLeaf(node) ? [node.pane] : node.children.flatMap(paneOrder)
}

export function paneOf(state: DockPanes, id: string): PaneId | null {
  for (const [pane, value] of Object.entries(state.panes)) if (value.tabs.includes(id)) return pane
  return null
}

/** A pane's tabs in strip order: views first, then documents. */
export function paneTabs(state: DockPanes, pane: PaneId): DockTab[] {
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]))
  const tabs = (state.panes[pane]?.tabs ?? []).map((id) => byId.get(id)).filter((tab): tab is DockTab => tab !== undefined)
  return [...tabs.filter(isViewTab), ...tabs.filter((tab) => !isViewTab(tab))]
}

/** The next pane after ``tabId``'s, round the end: "Move to Next Pane". */
export function nextPaneFor(state: DockPanes, tabId: string): PaneId | null {
  const from = paneOf(state, tabId)
  const shown = paneOrder(state.layout)
  if (!from || shown.length < 2) return null
  return shown[(shown.indexOf(from) + 1) % shown.length]
}

/** A tab can split off into a new pane, unless it is all its pane holds and that pane is the one splitting. */
export function canSplitOff(state: DockPanes, tabId: string, target: PaneId | null = paneOf(state, tabId)): boolean {
  const from = paneOf(state, tabId)
  if (!from || !target) return false
  return from !== target || state.panes[from].tabs.length > 1
}

/** The pane beside ``from`` on ``side``: the one sharing most of that edge. */
export function paneBeside(state: DockPanes, from: PaneId, side: SplitSide): PaneId | null {
  const { panes } = layoutBoxes(state.layout, new Set(paneOrder(state.layout)))
  const box = panes.get(from)
  if (!box) return null
  const EPS = 1e-6
  let best: PaneId | null = null
  let bestOverlap = EPS
  for (const [id, other] of panes) {
    if (id === from) continue
    const touches = side === 'right' ? Math.abs(other.left - (box.left + box.width)) < EPS
      : side === 'left' ? Math.abs(other.left + other.width - box.left) < EPS
        : side === 'down' ? Math.abs(other.top - (box.top + box.height)) < EPS
          : Math.abs(other.top + other.height - box.top) < EPS
    if (!touches) continue
    const overlap = side === 'left' || side === 'right'
      ? Math.min(box.top + box.height, other.top + other.height) - Math.max(box.top, other.top)
      : Math.min(box.left + box.width, other.left + other.width) - Math.max(box.left, other.left)
    if (overlap > bestOverlap) {
      best = id
      bestOverlap = overlap
    }
  }
  return best
}

/** What ⌃⌥+arrow does with ``pane``'s active tab ``tabId``. */
export type TabTowardPlan =
  | { kind: 'split'; pane: PaneId; tabId?: string }
  | { kind: 'move'; tabId: string; target: PaneId }

/**
 * ⌃⌥+arrow: the tab goes to ``side``. With other tabs beside it
 * the pane splits there with the tab moved in; a pane's only tab joins the
 * pane on that side instead (nothing is cloned, so it cannot split off);
 * with neither, or no tab, an empty pane opens on that side, as ⌘\ does.
 */
export function planTabToward(state: DockPanes, pane: PaneId, tabId: string | undefined, side: SplitSide): TabTowardPlan {
  if (tabId && canSplitOff(state, tabId, pane)) return { kind: 'split', pane, tabId }
  const beside = tabId ? paneBeside(state, pane, side) : null
  if (tabId && beside) return { kind: 'move', tabId, target: beside }
  return { kind: 'split', pane }
}

// ── Layout tree ─────────────────────────────────────────────────────────────

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/**
 * The same layout, tidy: a split inside a split of the same axis joins it,
 * a split of one child is that child, and sizes sum to 1.
 */
export function normalizeLayout(node: PaneLayout): PaneLayout {
  if (isPaneLeaf(node)) return node
  const total = sum(node.sizes) || 1
  const children: PaneLayout[] = []
  const sizes: number[] = []
  node.children.forEach((raw, index) => {
    const child = normalizeLayout(raw)
    const share = (node.sizes[index] ?? 0) / total
    if (!isPaneLeaf(child) && child.axis === node.axis) {
      child.children.forEach((inner, i) => {
        children.push(inner)
        sizes.push(share * child.sizes[i])
      })
    } else {
      children.push(child)
      sizes.push(share)
    }
  })
  if (children.length === 1) return children[0]
  return { axis: node.axis, children, sizes }
}

function holds(node: PaneLayout, pane: PaneId): boolean {
  return paneOrder(node).includes(pane)
}

/** ``node`` without ``pane``; its share goes to the child before it, else the one after. */
function withoutPane(node: PaneLayout, pane: PaneId): PaneLayout | null {
  if (isPaneLeaf(node)) return node.pane === pane ? null : node
  const index = node.children.findIndex((child) => holds(child, pane))
  if (index < 0) return node
  const rest = withoutPane(node.children[index], pane)
  if (rest) return { ...node, children: node.children.map((child, i) => (i === index ? rest : child)) }
  const children = node.children.filter((_, i) => i !== index)
  if (children.length === 0) return null
  const sizes = node.sizes.filter((_, i) => i !== index)
  sizes[index > 0 ? index - 1 : 0] += node.sizes[index]
  return { ...node, children, sizes }
}

/** The pane that takes ``pane``'s room when it closes (see ``withoutPane``). */
function heirOf(node: PaneLayout, pane: PaneId): PaneId | null {
  if (isPaneLeaf(node)) return null
  const index = node.children.findIndex((child) => holds(child, pane))
  if (index < 0) return null
  const child = node.children[index]
  if (!isPaneLeaf(child)) return heirOf(child, pane)
  const sibling = node.children[index > 0 ? index - 1 : 1]
  if (!sibling) return null
  const leaves = paneOrder(sibling)
  return index > 0 ? leaves[leaves.length - 1] : leaves[0]
}

const AXIS_OF: Record<SplitSide, Axis> = { left: 'row', right: 'row', up: 'column', down: 'column' }
const leads = (side: SplitSide) => side === 'left' || side === 'up'

/** ``target`` split in two on ``side``, ``fresh`` taking ``share`` of its room. */
function insertBeside(node: PaneLayout, target: PaneId, fresh: PaneId, side: SplitSide, share: number): PaneLayout {
  if (isPaneLeaf(node)) {
    if (node.pane !== target) return node
    return leads(side)
      ? { axis: AXIS_OF[side], children: [{ pane: fresh }, node], sizes: [share, 1 - share] }
      : { axis: AXIS_OF[side], children: [node, { pane: fresh }], sizes: [1 - share, share] }
  }
  return { ...node, children: node.children.map((child) => insertBeside(child, target, fresh, side, share)) }
}

// ── Writing ─────────────────────────────────────────────────────────────────

function withPane(state: DockPanes, id: PaneId, pane: Pane): DockPanes {
  return { ...state, panes: { ...state.panes, [id]: pane } }
}

function newPaneId(state: DockPanes): PaneId {
  const max = Math.max(0, ...Object.keys(state.panes).map((id) => Number(id.slice(1)) || 0))
  return `p${max + 1}`
}

/** Show ``id`` in ``pane`` and focus it. */
function reveal(state: DockPanes, pane: PaneId, id: string): DockPanes {
  const recent = state.recent?.[0] === id ? state.recent : [id, ...(state.recent ?? []).filter((item) => item !== id)].slice(0, RECENT_LIMIT)
  return { ...withPane(state, pane, { ...state.panes[pane], active: id }), focused: pane, recent }
}

/** Where tabs open unless a pane is named: the focused pane. */
function targetPane(state: DockPanes): PaneId {
  return state.panes[state.focused] ? state.focused : paneOrder(state.layout)[0]
}

export interface OpenTabOptions {
  /** A pane, or by default the focused one. */
  pane?: PaneId
  /** Open as the pane's preview tab, replacing the current one. */
  preview?: boolean
}

/**
 * Open ``tab``: an open one is updated in place and shown; a new one replaces
 * its pane's preview tab (``preview``) or goes right after the pane's active
 * tab.
 */
export function openTab(state: DockPanes, tab: DockTab, { pane, preview = false }: OpenTabOptions = {}): DockPanes {
  const at = paneOf(state, tab.id)
  if (at) {
    const tabs = state.tabs.map((item) => (item.id === tab.id ? tab : item))
    const current = state.panes[at]
    const kept = !preview && current.preview === tab.id ? { ...current, preview: null } : current
    return reveal(withPane({ ...state, tabs }, at, kept), at, tab.id)
  }
  const target = pane && state.panes[pane] ? pane : targetPane(state)
  const current = state.panes[target]
  const replacing = preview && current.preview && current.tabs.includes(current.preview) ? current.preview : null
  let ids: string[]
  let tabs: DockTab[]
  if (replacing) {
    ids = current.tabs.map((id) => (id === replacing ? tab.id : id))
    tabs = [...state.tabs.filter((item) => item.id !== replacing), tab]
  } else {
    const after = current.tabs.indexOf(current.active)
    ids = after < 0 ? [...current.tabs, tab.id] : [...current.tabs.slice(0, after + 1), tab.id, ...current.tabs.slice(after + 1)]
    tabs = [...state.tabs, tab]
  }
  const next = withPane({ ...state, tabs }, target, { ...current, tabs: ids, preview: preview ? tab.id : current.preview })
  return reveal(next, target, tab.id)
}

/** Keep a preview tab: the next preview opens beside it. */
export function keepTab(state: DockPanes, id: string): DockPanes {
  const at = paneOf(state, id)
  if (!at || state.panes[at].preview !== id) return state
  return withPane(state, at, { ...state.panes[at], preview: null })
}

export function activateTab(state: DockPanes, id: string): DockPanes {
  const at = paneOf(state, id)
  return at ? reveal(state, at, id) : state
}

export function focusPane(state: DockPanes, pane: PaneId): DockPanes {
  return state.focused === pane || !state.panes[pane] ? state : { ...state, focused: pane }
}

/**
 * The tab shown when ``id`` closes: the latest used of the strip's other
 * tabs, else its right neighbour, else its left.
 */
function heirTab(state: DockPanes, strip: readonly string[], id: string, closing: ReadonlySet<string>): string {
  const used = state.recent?.find((item) => item !== id && !closing.has(item) && strip.includes(item))
  if (used) return used
  const index = strip.indexOf(id)
  const right = strip.slice(index + 1).find((item) => !closing.has(item))
  const left = strip.slice(0, Math.max(0, index)).reverse().find((item) => !closing.has(item))
  return right ?? left ?? ''
}

/**
 * Close ``pane`` (an empty one, or one whose tabs left): its room goes to a
 * neighbour, and so does the focus if it had it. The last pane stays, empty.
 */
export function closePane(state: DockPanes, pane: PaneId): DockPanes {
  const closing = state.panes[pane]
  if (!closing) return state
  const tabs = state.tabs.filter((tab) => !closing.tabs.includes(tab.id))
  const order = paneOrder(state.layout)
  if (order.length <= 1) return { ...state, tabs, panes: { [pane]: emptyPane() }, focused: pane }
  const heir = heirOf(state.layout, pane)
  const panes = Object.fromEntries(Object.entries(state.panes).filter(([id]) => id !== pane))
  const layout = normalizeLayout(withoutPane(state.layout, pane) ?? { pane: order.find((id) => id !== pane)! })
  const next: DockPanes = { ...state, tabs, panes, layout }
  return state.focused === pane ? { ...next, focused: heir ?? paneOrder(layout)[0] } : next
}

/** Close tabs; a pane left without tabs closes too. */
export function closeTabs(state: DockPanes, ids: readonly string[]): DockPanes {
  const closing = new Set(ids)
  if (closing.size === 0) return state
  let next: DockPanes = {
    ...state,
    tabs: state.tabs.filter((tab) => !closing.has(tab.id)),
    ...(state.recent ? { recent: state.recent.filter((item) => !closing.has(item)) } : {}),
  }
  const emptied: PaneId[] = []
  for (const [id, pane] of Object.entries(state.panes)) {
    if (!pane.tabs.some((tab) => closing.has(tab))) continue
    const strip = paneTabs(state, id).map((tab) => tab.id)
    const tabs = pane.tabs.filter((tab) => !closing.has(tab))
    next = withPane(next, id, {
      tabs,
      active: closing.has(pane.active) ? heirTab(state, strip, pane.active, closing) : pane.active,
      preview: pane.preview && closing.has(pane.preview) ? null : pane.preview,
    })
    if (tabs.length === 0) emptied.push(id)
  }
  for (const id of emptied) next = closePane(next, id)
  return next
}

/**
 * Move a tab to ``toIndex`` of its strip (drag, ⌥⇧←/→, the tab menu). Views
 * stay before documents, so the index is kept within the tab's own kind.
 */
export function moveWithinPane(state: DockPanes, id: string, toIndex: number): DockPanes {
  const pane = paneOf(state, id)
  if (!pane) return state
  const strip = paneTabs(state, pane)
  const from = strip.findIndex((tab) => tab.id === id)
  if (from < 0) return state
  const views = strip.filter(isViewTab).length
  const [min, max] = isViewTab(strip[from]) ? [0, views - 1] : [views, strip.length - 1]
  const to = clamp(toIndex, min, max)
  if (to === from) return state
  const order = strip.map((tab) => tab.id)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  return withPane(state, pane, { ...state.panes[pane], tabs: order })
}

/**
 * Move a tab into ``target`` at ``index`` of its strip (the end of its kind
 * by default) and show it there. Its old pane closes if that was its last
 * tab. A moved preview tab is kept: moving it is a choice.
 */
export function moveTab(state: DockPanes, id: string, target: PaneId, index?: number): DockPanes {
  const from = paneOf(state, id)
  const tab = state.tabs.find((item) => item.id === id)
  if (!from || !tab || !state.panes[target]) return state
  if (from === target) return index === undefined ? state : moveWithinPane(state, id, index)
  const source = state.panes[from]
  const strip = paneTabs(state, from).map((item) => item.id)
  let next = withPane(state, from, {
    tabs: source.tabs.filter((item) => item !== id),
    active: source.active === id ? heirTab(state, strip, id, new Set([id])) : source.active,
    preview: source.preview === id ? null : source.preview,
  })
  const there = paneTabs(next, target)
  const views = there.filter(isViewTab).length
  const [min, max] = isViewTab(tab) ? [0, views] : [views, there.length]
  const order = there.map((item) => item.id)
  order.splice(clamp(index ?? max, min, max), 0, id)
  next = reveal(withPane(next, target, { ...next.panes[target], tabs: order }), target, id)
  return next.panes[from].tabs.length === 0 ? closePane(next, from) : next
}

/**
 * Split ``target`` on ``side``: a new pane takes half its room and the focus,
 * empty (its launcher) or with ``tabId`` moved into it.
 */
export function splitPane(state: DockPanes, target: PaneId, side: SplitSide, tabId?: string): DockPanes {
  if (!state.panes[target]) return state
  if (tabId !== undefined && !canSplitOff(state, tabId, target)) return state
  const fresh = newPaneId(state)
  const next: DockPanes = {
    ...withPane(state, fresh, emptyPane()),
    layout: normalizeLayout(insertBeside(state.layout, target, fresh, side, 0.5)),
    focused: fresh,
  }
  return tabId === undefined ? next : moveTab(next, tabId, fresh)
}

/** Phones have one strip: every pane's tabs, in layout order, in the first pane. */
export function joinPanes(state: DockPanes): DockPanes {
  const order = paneOrder(state.layout)
  if (order.length <= 1) return state
  const first = order[0]
  const focused = state.panes[state.focused]
  const active = focused?.active || order.map((id) => state.panes[id].active).find(Boolean) || ''
  return {
    ...state,
    panes: { [first]: { tabs: order.flatMap((id) => state.panes[id].tabs), active, preview: focused?.preview ?? null } },
    layout: { pane: first },
    focused: first,
  }
}

/** The split at ``path`` (child indexes from the root) with new ``sizes``. */
export function resizeSplit(state: DockPanes, path: readonly number[], sizes: readonly number[]): DockPanes {
  const apply = (node: PaneLayout, depth: number): PaneLayout => {
    if (isPaneLeaf(node)) return node
    if (depth === path.length) return sizes.length === node.children.length ? { ...node, sizes: [...sizes] } : node
    return { ...node, children: node.children.map((child, i) => (i === path[depth] ? apply(child, depth + 1) : child)) }
  }
  return { ...state, layout: apply(state.layout, 0) }
}

export interface TerminalInfo {
  id: string
  title: string
}

/**
 * Keep terminal tabs in step with the workspace's shells without moving
 * them: ended ones drop out, renamed ones update, new ones join the focused
 * pane (shown only if it was empty, and then ``preferredId`` — the shell that
 * was in front before a reload — wins over the first). ``preferredId`` never
 * takes the front from a pane that already shows a tab.
 */
export function syncTerminalTabs(state: DockPanes, terminals: readonly TerminalInfo[], preferredId?: string): DockPanes {
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
  let next: DockPanes = { ...state, tabs: [...tabs, ...added] }
  if (added.length > 0) {
    const target = targetPane(next)
    const pane = next.panes[target]
    next = withPane(next, target, {
      ...pane,
      tabs: [...pane.tabs, ...added.map((tab) => tab.id)],
      active: pane.active || (added.find((tab) => tab.type === 'terminal' && tab.termId === preferredId) ?? added[0]).id,
    })
  }
  return gone.length > 0 ? closeTabs(next, gone) : next
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** A box in fractions of the panes' area. */
export interface PaneBox {
  left: number
  top: number
  width: number
  height: number
}

/** The bar between two children of a split, on screen. */
export interface SplitBar {
  /** The split's place in the layout (child indexes from the root). */
  path: number[]
  axis: Axis
  /** The children on either side (hidden ones in between are skipped). */
  before: number
  after: number
  /** The children on screen, which share the split's room. */
  shown: number[]
  /** The split's box, and the bar's place along its axis (0–1 of the box). */
  box: PaneBox
  at: number
}

/**
 * Where each pane on screen goes, and the bars between them. ``sizesAt``
 * overrides a split's sizes while its bar is dragged (keyed ``path.join('.')``).
 */
export function layoutBoxes(
  layout: PaneLayout,
  shown: ReadonlySet<PaneId>,
  sizesAt?: (key: string) => readonly number[] | undefined,
): { panes: Map<PaneId, PaneBox>; bars: SplitBar[] } {
  const panes = new Map<PaneId, PaneBox>()
  const bars: SplitBar[] = []
  const walk = (node: PaneLayout, box: PaneBox, path: number[]) => {
    if (isPaneLeaf(node)) {
      if (shown.has(node.pane)) panes.set(node.pane, box)
      return
    }
    const sizes = sizesAt?.(path.join('.')) ?? node.sizes
    const visible = node.children.map((_, i) => i).filter((i) => paneOrder(node.children[i]).some((id) => shown.has(id)))
    const total = sum(visible.map((i) => sizes[i])) || 1
    let offset = 0
    visible.forEach((i, k) => {
      const share = sizes[i] / total
      if (k > 0) bars.push({ path, axis: node.axis, before: visible[k - 1], after: i, shown: visible, box, at: offset })
      const child = node.axis === 'row'
        ? { left: box.left + offset * box.width, top: box.top, width: share * box.width, height: box.height }
        : { left: box.left, top: box.top + offset * box.height, width: box.width, height: share * box.height }
      walk(node.children[i], child, [...path, i])
      offset += share
    })
  }
  walk(layout, { left: 0, top: 0, width: 1, height: 1 }, [])
  return { panes, bars }
}

/**
 * A split's sizes with the bar between ``before`` and ``after`` moved to
 * ``at`` (0–1 along the split's room on screen), neither side below ``min``
 * of that room (both halve it when there is not enough).
 */
export function sizesWithBarAt(sizes: readonly number[], bar: Pick<SplitBar, 'before' | 'after' | 'shown'>, at: number, min: number): number[] {
  const { before, after, shown } = bar
  const total = sum(shown.map((i) => sizes[i])) || 1
  const start = sum(shown.filter((i) => i < before).map((i) => sizes[i])) / total
  const pair = sizes[before] + sizes[after]
  const room = pair / total
  const floor = Math.min(min, room / 2)
  const first = clamp(at - start, floor, room - floor)
  const next = [...sizes]
  next[before] = first * total
  next[after] = pair - first * total
  return next
}

// ── Persistence ─────────────────────────────────────────────────────────────

export interface SavedDockPanes {
  v: 2
  tabs: DockTab[]
  panes: Record<PaneId, Pane>
  layout: PaneLayout
  focused: PaneId
}

/**
 * What a session remembers. Uploads are not saved (their panes close with
 * them). Terminals are, by id: still running, they come back where they were;
 * ended, the sync drops them. (Older saves also carry ``terminalsHidden``,
 * from when a key hid a pane of terminals; it is ignored, so those panes show.)
 */
export function serializeDockPanes(state: DockPanes): SavedDockPanes {
  const kept = closeTabs(state, state.tabs.filter((tab) => tab.type === 'attachment').map((tab) => tab.id))
  return {
    v: 2,
    tabs: kept.tabs.map((tab) => (tab.type === 'preview' ? { ...tab, navKey: 0 } : tab)),
    panes: kept.panes,
    layout: kept.layout,
    focused: kept.focused,
  }
}

function isTab(value: unknown): value is DockTab {
  return typeof value === 'object' && value !== null && typeof (value as DockTab).id === 'string' && typeof (value as DockTab).type === 'string'
}

const isId = (value: unknown): value is string => typeof value === 'string'

/** A saved layout, if every split is well formed; sizes are evened out when they are not. */
function readLayout(value: unknown, seen: Set<string>): PaneLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const node = value as Record<string, unknown>
  if (isId(node.pane)) {
    if (seen.has(node.pane)) return null
    seen.add(node.pane)
    return { pane: node.pane }
  }
  if ((node.axis !== 'row' && node.axis !== 'column') || !Array.isArray(node.children) || node.children.length === 0) return null
  const children: PaneLayout[] = []
  for (const child of node.children) {
    const read = readLayout(child, seen)
    if (!read) return null
    children.push(read)
  }
  const sizes = Array.isArray(node.sizes) && node.sizes.length === children.length
    && node.sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0)
    ? node.sizes as number[]
    : children.map(() => 1)
  return { axis: node.axis, children, sizes }
}

function readPane(value: unknown, ids: ReadonlySet<string>, taken: Set<string>): Pane {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Pane>
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).filter((id): id is string => isId(id) && ids.has(id) && !taken.has(id))
  for (const id of tabs) taken.add(id)
  return {
    tabs,
    // A terminal can stay active: it is adopted again if it still runs.
    active: isId(raw.active) ? raw.active : '',
    preview: isId(raw.preview) && tabs.includes(raw.preview) ? raw.preview : null,
  }
}

/** A save from the two-group panel (``lower``, ``active`` pair): two stacked panes. */
function restoreTwoGroups(value: Record<string, unknown>, tabs: DockTab[]): DockPanes {
  const ids = new Set(tabs.map((tab) => tab.id))
  const split = value.split === true
  const lower = new Set(split && Array.isArray(value.lower) ? value.lower.filter((id): id is string => isId(id) && ids.has(id)) : [])
  const active = Array.isArray(value.active) ? value.active : []
  const preview = Array.isArray(value.preview) ? value.preview : []
  const pane = (group: 0 | 1): Pane => {
    const mine = tabs.filter((tab) => lower.has(tab.id) === (group === 1)).map((tab) => tab.id)
    return {
      tabs: mine,
      active: isId(active[group]) ? active[group] : '',
      preview: isId(preview[group]) && mine.includes(preview[group]) ? preview[group] : null,
    }
  }
  // Shells were not saved then: a lower pane of only shells comes back empty.
  if (!split || lower.size === 0) return { ...EMPTY_DOCK_PANES, tabs, panes: { p1: pane(0) } }
  return {
    tabs,
    panes: { p1: pane(0), p2: pane(1) },
    layout: { axis: 'column', children: [{ pane: 'p1' }, { pane: 'p2' }], sizes: [UPPER_SHARE, 1 - UPPER_SHARE] },
    focused: value.focused === 1 ? 'p2' : 'p1',
  }
}

/** A saved state, or ``null`` when it is missing or unreadable. */
export function restoreDockPanes(saved: unknown): DockPanes | null {
  if (typeof saved !== 'object' || saved === null) return null
  const value = saved as Record<string, unknown>
  if (!Array.isArray(value.tabs) || !value.tabs.every(isTab)) return null
  const tabs = value.tabs as DockTab[]
  if (value.v !== 2) return restoreTwoGroups(value, tabs)
  const read = readLayout(value.layout, new Set())
  if (!read || typeof value.panes !== 'object' || value.panes === null) return null
  const layout = normalizeLayout(read)
  const ids = new Set(tabs.map((tab) => tab.id))
  const taken = new Set<string>()
  const savedPanes = value.panes as Record<string, unknown>
  const panes = Object.fromEntries(paneOrder(layout).map((id) => [id, readPane(savedPanes[id], ids, taken)]))
  const order = paneOrder(layout)
  return {
    tabs: tabs.filter((tab) => taken.has(tab.id)),
    panes,
    layout,
    focused: isId(value.focused) && order.includes(value.focused) ? value.focused : order[0],
  }
}

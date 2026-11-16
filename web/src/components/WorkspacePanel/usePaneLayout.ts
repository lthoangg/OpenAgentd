/**
 * Where the dock's panes sit, and how the bars between them resize: the
 * React side of ``dock-panes.ts``. Each pane on screen gets a box (fractions
 * of the panes' area); a bar drag shows its split's sizes live and commits
 * them on the drop, snapping onto the even split; a new pane fades in.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DOCK_PANE_MIN_HEIGHT, DOCK_PANE_MIN_WIDTH } from '@/lib/workbench-layout'
import { SNAP_THRESHOLD_PX, snapToDetent } from '@/lib/resize-snap'
import { DURATIONS_S, EASINGS, cssEasing } from '@/lib/motion'
import {
  type Axis,
  type DockPanes,
  type PaneBox,
  type PaneId,
  type PaneLayout,
  type SplitBar,
  isPaneLeaf,
  layoutBoxes,
  paneOrder,
  sizesWithBarAt,
} from './dock-panes'

/**
 * A pane's place over the panes' area (``top``: an inset from its top, the
 * tab strip for a preview page). The hairline before a pane belongs to the
 * bar there, so the pane starts 1px in.
 */
export function paneStyle(box: PaneBox, top = '0px'): React.CSSProperties {
  const x = box.left > 0 ? 1 : 0
  const y = box.top > 0 ? 1 : 0
  return {
    left: `calc(${box.left * 100}% + ${x}px)`,
    top: `calc(${box.top * 100}% + ${y}px + ${top})`,
    width: `calc(${box.width * 100}% - ${x}px)`,
    height: `calc(${box.height * 100}% - ${y}px - ${top})`,
  }
}

/** A bar's 7px hit area, centred on the line between two panes. */
export function barStyle(bar: SplitBar): React.CSSProperties {
  const { box, at } = bar
  return bar.axis === 'row'
    ? { left: `calc(${(box.left + at * box.width) * 100}% - 3px)`, top: `${box.top * 100}%`, height: `${box.height * 100}%` }
    : { top: `calc(${(box.top + at * box.height) * 100}% - 3px)`, left: `${box.left * 100}%`, width: `${box.width * 100}%` }
}

export function usePaneLayout({
  panes,
  shownPanes,
  panesRef,
  resizeSplit,
  mobile,
  prefersReducedMotion,
}: {
  panes: DockPanes
  shownPanes: readonly PaneId[]
  panesRef: React.RefObject<HTMLDivElement | null>
  resizeSplit: (path: readonly number[], sizes: number[]) => void
  mobile: boolean
  prefersReducedMotion: boolean | null
}) {
  // Maximize (⌘⇧D) grows the whole panel: every pane stays on screen.
  const onScreen = useMemo(() => new Set(shownPanes), [shownPanes])
  const many = onScreen.size > 1
  // A bar being dragged: its split's sizes until the drop.
  const [liveSizes, setLiveSizes] = useState<{ key: string; sizes: number[] } | null>(null)
  const { panes: boxes, bars } = useMemo(
    () => layoutBoxes(panes.layout, onScreen, (key) => (liveSizes?.key === key ? liveSizes.sizes : undefined)),
    [panes.layout, onScreen, liveSizes],
  )
  // Panes in the order they were made, so a split never moves one in the
  // DOM (a moved iframe reloads); F6 follows the layout (``data-focus-order``).
  const paneIds = useMemo(() => Object.keys(panes.panes).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), [panes.panes])
  const layoutIndex = useMemo(() => new Map(paneOrder(panes.layout).map((id, index) => [id, index])), [panes.layout])
  // A split's new pane fades in at ``base`` (opacity only: pane sizes are
  // never animated). The panes already there at mount, and a phone, do not.
  const knownPanes = useRef<Set<string> | null>(null)
  useLayoutEffect(() => {
    const known = knownPanes.current
    knownPanes.current = new Set(paneIds)
    if (!known || mobile || prefersReducedMotion) return
    for (const id of paneIds) {
      if (known.has(id)) continue
      const node = panesRef.current?.querySelector<HTMLElement>(`[data-dock-pane="${id}"]`)
      if (node && typeof node.animate === 'function') {
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATIONS_S.base * 1000, easing: cssEasing(EASINGS.out) })
      }
    }
  }, [paneIds, mobile, prefersReducedMotion, panesRef])
  // The panel-wide Maximize sits on the top-right pane, as in an editor.
  const cornerPane = useMemo(() => {
    let best: PaneId | null = null
    let right = -1
    for (const [pane, box] of boxes) {
      if (box.top === 0 && box.left + box.width > right + 1e-9) {
        best = pane
        right = box.left + box.width
      }
    }
    return best
  }, [boxes])

  const splitAt = (path: readonly number[]): Extract<PaneLayout, { axis: Axis }> | null => {
    let node: PaneLayout = panes.layout
    for (const index of path) {
      if (isPaneLeaf(node)) return null
      node = node.children[index]
    }
    return isPaneLeaf(node) ? null : node
  }
  /** A bar's split on screen, in px, and the least share a pane keeps there. */
  const barExtent = (bar: SplitBar) => {
    const rect = panesRef.current?.getBoundingClientRect()
    if (!rect) return null
    const row = bar.axis === 'row'
    const start = row ? rect.left + bar.box.left * rect.width : rect.top + bar.box.top * rect.height
    const size = row ? bar.box.width * rect.width : bar.box.height * rect.height
    return size > 0 ? { start, size, min: (row ? DOCK_PANE_MIN_WIDTH : DOCK_PANE_MIN_HEIGHT) / size } : null
  }
  /** Moves a bar to a pointer position; answers whether it snapped onto the even split. */
  const dragBar = (bar: SplitBar, clientX: number, clientY: number, done: boolean): boolean => {
    const node = splitAt(bar.path)
    const extent = barExtent(bar)
    if (!node || !extent) return false
    const pointer = ((bar.axis === 'row' ? clientX : clientY) - extent.start) / extent.size
    // ``evenOut`` gives each shown pane an equal share: the bar's detent.
    const even = (bar.shown.indexOf(bar.before) + 1) / bar.shown.length
    const { value: at, snapped } = snapToDetent(pointer, even, SNAP_THRESHOLD_PX / extent.size)
    const sizes = sizesWithBarAt(node.sizes, bar, at, extent.min)
    if (!done) {
      setLiveSizes({ key: bar.path.join('.'), sizes })
      return snapped
    }
    setLiveSizes(null)
    resizeSplit(bar.path, sizes)
    return snapped
  }
  const stepBar = (bar: SplitBar, px: number) => {
    const node = splitAt(bar.path)
    const extent = barExtent(bar)
    if (node && extent) resizeSplit(bar.path, sizesWithBarAt(node.sizes, bar, bar.at + px / extent.size, extent.min))
  }
  /** Double-click or Enter: the panes of that split share its room evenly. */
  const evenOut = (bar: SplitBar) => {
    const node = splitAt(bar.path)
    if (!node) return
    const share = bar.shown.reduce((total, index) => total + node.sizes[index], 0) / bar.shown.length
    resizeSplit(bar.path, node.sizes.map((size, index) => (bar.shown.includes(index) ? share : size)))
  }
  /** A bar's ``aria-valuenow``: the share of the pane before it, of the two it divides. */
  const barValueNow = (bar: SplitBar) => {
    const sizes = (liveSizes?.key === bar.path.join('.') ? liveSizes.sizes : splitAt(bar.path)?.sizes) ?? []
    const pair = (sizes[bar.before] ?? 0) + (sizes[bar.after] ?? 0)
    return pair > 0 ? Math.round(((sizes[bar.before] ?? 0) / pair) * 100) : 50
  }

  return { boxes, bars, many, paneIds, layoutIndex, cornerPane, barValueNow, dragBar, stepBar, evenOut }
}

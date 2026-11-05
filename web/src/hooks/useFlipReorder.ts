/**
 * useFlipReorder — slide list rows to their new place when the list reorders,
 * instead of letting them jump (FLIP: first, last, invert, play).
 *
 * Rows opt in with `data-flip-id="<stable id>"` anywhere under `rootRef`, so
 * a row moving between groups under one root (Working → Recent) animates too.
 * When the id order under the root changed in a commit, rows that moved play
 * from their old position and rows that just appeared fade in.
 *
 * Cost: a commit that keeps the order only reads the row ids, never layout,
 * so a parent re-rendering every frame (the phone drawer's drag) stays cheap.
 * Positions are read on an order change, and refreshed when the list's height
 * changes (a group folds, Show more, a draft row): the only other ways a row
 * moves. A width-only resize keeps the one-line rows where they are.
 *
 * - Layout positions come from `offsetTop`, which ignores transforms, so a row
 *   still mid-animation is measured where it will land, not where it is drawn.
 * - Only an order change animates, so ordinary updates never move anything.
 * - Rows off screen both before and after are left alone: a row jumping from
 *   the bottom of a long list to the top moves every row it passes, and only
 *   the visible ones are worth a compositor layer.
 * - The first commit only records the baseline: lists never animate in.
 * - Off under `prefers-reduced-motion`, and where `Element.animate` is missing.
 * - A second reorder landing mid-slide starts from where the row is drawn
 *   (transform included), not from where its layout was, so nothing jumps.
 *
 * Options: `axis: 'x'` slides a horizontal strip (the dock's tab bar) from
 * `offsetLeft`; `attr` names the id attribute (default `data-flip-id`);
 * `enter: 'rise'` brings new rows in at `fast` from 2px below instead of the
 * `base` fade; `skip` is asked on every order change and, when true, records
 * the new order without animating (a drag already moved the rows). A
 * horizontal strip re-reads positions on every commit, since a tab that
 * changes width moves its neighbours without a resize of the strip.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S, EASINGS, cssEasing } from '@/lib/motion'

const EASE = cssEasing(EASINGS.out)

export interface FlipReorderOptions {
  /** Slide vertically (default, lists) or horizontally (a tab strip). */
  axis?: 'x' | 'y'
  /** The attribute rows carry their stable id in (default `data-flip-id`). */
  attr?: string
  /** How a row that was not listed before arrives. */
  enter?: 'fade' | 'rise'
  /** True to take an order change without animating it. */
  skip?: () => boolean
}

type Axis = 'x' | 'y'

/** Start of `el` relative to `root` along `axis`, from layout (transforms ignored). */
function layoutStart(el: HTMLElement, root: HTMLElement, axis: Axis): number {
  const offset = (node: HTMLElement) => (axis === 'x' ? node.offsetLeft : node.offsetTop)
  let start = 0
  let node: HTMLElement | null = el
  while (node && node !== root) {
    start += offset(node)
    const parent = node.offsetParent as HTMLElement | null
    // An offsetParent above the root: measure both against it instead.
    if (parent && !root.contains(parent)) return start - offset(root)
    node = parent
  }
  return start
}

function flipRows(root: HTMLElement, attr: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`))
}

function rowOrder(rows: readonly HTMLElement[], attr: string): string {
  return rows.map((row) => row.getAttribute(attr)).join('\n')
}

function measure(rows: readonly HTMLElement[], root: HTMLElement, attr: string, axis: Axis): Map<string, number> {
  const starts = new Map<string, number>()
  for (const row of rows) starts.set(row.getAttribute(attr)!, layoutStart(row, root, axis))
  return starts
}

/** Nearest scrolling ancestor, which clips the rows. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

/**
 * The band of root-relative layout positions the user can see, or `null`
 * when nothing clips the list (then every row counts as visible).
 */
function visibleBand(root: HTMLElement): { top: number; bottom: number } | null {
  const scroller = scrollParent(root)
  if (!scroller || scroller.clientHeight === 0) return null
  // Both rects carry the same transforms (a sliding drawer), so the
  // difference is the scroller's top in root layout coordinates.
  const top = scroller.getBoundingClientRect().top - root.getBoundingClientRect().top
  return { top, bottom: top + scroller.clientHeight }
}

export function useFlipReorder(rootRef: RefObject<HTMLElement | null>, options: FlipReorderOptions = {}): void {
  const { axis = 'y', attr = 'data-flip-id', enter = 'fade' } = options
  const reducedMotion = useReducedMotion()
  const previous = useRef<{ order: string; tops: Map<string, number> } | null>(null)
  const skipRef = useRef(options.skip)
  skipRef.current = options.skip

  // The height changed without the order changing: rows moved, so the next
  // reorder must start from where they are now.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    let height: number | null = null
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.height ?? null
      if (next === height) return
      height = next
      if (!previous.current) return
      const rows = flipRows(root, attr)
      previous.current = { order: rowOrder(rows, attr), tops: measure(rows, root, attr, axis) }
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [rootRef, attr, axis])

  // No deps: every commit of the owner checks the order, which is cheap.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const rows = flipRows(root, attr)
    const order = rowOrder(rows, attr)
    const before = previous.current
    if (before?.order === order) {
      if (axis === 'x') previous.current = { order, tops: measure(rows, root, attr, axis) }
      return
    }
    const tops = measure(rows, root, attr, axis)
    previous.current = { order, tops }
    if (!before || reducedMotion) return
    if (skipRef.current?.()) return

    const band = axis === 'y' ? visibleBand(root) : null
    const seen = (top: number, height: number) => !band || (top + height > band.top && top < band.bottom)
    const duration = DURATIONS_S.base * 1000
    const enterDuration = (enter === 'rise' ? DURATIONS_S.fast : DURATIONS_S.base) * 1000
    const enterFrom: Keyframe = enter === 'rise' ? { opacity: 0, transform: 'translateY(2px)' } : { opacity: 0 }
    const enterTo: Keyframe = enter === 'rise' ? { opacity: 1, transform: 'none' } : { opacity: 1 }
    const move = (px: number) => (axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`)
    for (const row of rows) {
      if (typeof row.animate !== 'function') return
      const id = row.getAttribute(attr)!
      const from = before.tops.get(id)
      const to = tops.get(id)!
      // Slides and fades only: a colour transition on the row is not motion to follow.
      const running = (row.getAnimations?.() ?? []).filter((anim) => !('transitionProperty' in anim))
      // Mid-slide, the row is drawn off its layout spot: start from there.
      // The drawn position includes the running transform, the layout one
      // does not, so the difference of the two rects is that transform.
      let drawn = 0
      if (running.length > 0) {
        const axisStart = (rect: DOMRect) => (axis === 'x' ? rect.left : rect.top)
        const drawnAt = axisStart(row.getBoundingClientRect())
        for (const anim of running) {
          anim.finished.catch(() => {})
          anim.cancel()
        }
        drawn = drawnAt - axisStart(row.getBoundingClientRect())
      }
      const delta = from === undefined ? null : from - to + drawn
      if (delta !== null && Math.abs(delta) < 1) continue
      const size = axis === 'x' ? row.offsetWidth : row.offsetHeight
      if (!seen(to, size) && (from === undefined || !seen(from, size))) continue
      if (delta === null) {
        row.animate([enterFrom, enterTo], { duration: enterDuration, easing: EASE })
      } else {
        row.animate([{ transform: move(delta) }, { transform: 'none' }], { duration, easing: EASE })
      }
    }
  })
}

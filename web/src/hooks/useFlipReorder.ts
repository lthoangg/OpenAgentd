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
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'

const EASE = `cubic-bezier(${EASINGS.out.join(', ')})`

/** Top of `el` relative to `root`, from layout (transforms ignored). */
function layoutTop(el: HTMLElement, root: HTMLElement): number {
  let top = 0
  let node: HTMLElement | null = el
  while (node && node !== root) {
    top += node.offsetTop
    const parent = node.offsetParent as HTMLElement | null
    // An offsetParent above the root: measure both against it instead.
    if (parent && !root.contains(parent)) return top - root.offsetTop
    node = parent
  }
  return top
}

function flipRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-flip-id]'))
}

function rowOrder(rows: readonly HTMLElement[]): string {
  return rows.map((row) => row.dataset.flipId).join('\n')
}

function measure(rows: readonly HTMLElement[], root: HTMLElement): Map<string, number> {
  const tops = new Map<string, number>()
  for (const row of rows) tops.set(row.dataset.flipId!, layoutTop(row, root))
  return tops
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

export function useFlipReorder(rootRef: RefObject<HTMLElement | null>): void {
  const reducedMotion = useReducedMotion()
  const previous = useRef<{ order: string; tops: Map<string, number> } | null>(null)

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
      const rows = flipRows(root)
      previous.current = { order: rowOrder(rows), tops: measure(rows, root) }
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [rootRef])

  // No deps: every commit of the owner checks the order, which is cheap.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const rows = flipRows(root)
    const order = rowOrder(rows)
    const before = previous.current
    if (before?.order === order) return
    const tops = measure(rows, root)
    previous.current = { order, tops }
    if (!before || reducedMotion) return

    const band = visibleBand(root)
    const seen = (top: number, height: number) => !band || (top + height > band.top && top < band.bottom)
    const duration = DURATIONS_S.base * 1000
    for (const row of rows) {
      if (typeof row.animate !== 'function') return
      const id = row.dataset.flipId!
      const from = before.tops.get(id)
      const to = tops.get(id)!
      const delta = from === undefined ? null : from - to
      if (delta !== null && Math.abs(delta) < 1) continue
      const height = row.offsetHeight
      if (!seen(to, height) && (from === undefined || !seen(from, height))) continue
      for (const running of row.getAnimations?.() ?? []) running.cancel()
      if (delta === null) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE })
      } else {
        row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration, easing: EASE })
      }
    }
  })
}

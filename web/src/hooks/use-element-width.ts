import { useEffect, useState, type RefObject } from 'react'

const identity = (width: number) => width
const renderedWidth = (node: HTMLElement) => node.getBoundingClientRect().width

/**
 * Track a value derived from an element's rendered width, re-rendering only
 * when that value changes. A shell that needs one bit ("is the center too
 * narrow?") can pass a boolean ``select`` and skip the per-frame re-renders a
 * raw width causes during a sidebar tween or window drag.
 *
 * ``read`` replaces the rendered width, for example with the width the
 * element settles at once a neighbouring panel finishes its tween.
 * ``remeasureOn`` subscribes to something that changes that width before a
 * resize can be observed (a neighbour starting its tween): its callback
 * measures at once, so an update made in a commit lands before the paint.
 *
 * Falls back to the window width when the element has no layout yet (first
 * paint, test DOMs) or ResizeObserver is unavailable, and coalesces bursts to
 * one measurement per animation frame. Pass stable (module-level) ``select``,
 * ``read`` and ``remeasureOn``: a new function each render re-subscribes.
 */
export function useElementWidthSelect<T>(
  ref: RefObject<HTMLElement | null>,
  select: (width: number) => T,
  read: (node: HTMLElement) => number = renderedWidth,
  remeasureOn?: (node: HTMLElement, remeasure: () => void) => () => void,
): T {
  const [value, setValue] = useState(() => select(typeof window === 'undefined' ? 0 : window.innerWidth))

  useEffect(() => {
    const node = ref.current
    if (typeof window === 'undefined') return
    let frame: number | null = null
    const measure = () => {
      frame = null
      const measured = node ? read(node) : 0
      const next = select(Math.round(measured > 0 ? measured : window.innerWidth))
      setValue((prev) => (Object.is(prev, next) ? prev : next))
    }
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(measure)
    }
    measure()
    let observer: ResizeObserver | null = null
    if (node && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(node)
    }
    window.addEventListener('resize', schedule)
    const remeasure = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      measure()
    }
    const stopRemeasuring = node && remeasureOn ? remeasureOn(node, remeasure) : undefined
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      stopRemeasuring?.()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [ref, select, read, remeasureOn])

  return value
}

/** Track an element's rendered width (rounded px). */
export function useElementWidth(
  ref: RefObject<HTMLElement | null>,
  read?: (node: HTMLElement) => number,
  remeasureOn?: (node: HTMLElement, remeasure: () => void) => () => void,
): number {
  return useElementWidthSelect(ref, identity, read, remeasureOn)
}

/**
 * useHeightGlide — a box whose content grows or shrinks glides to its new
 * height instead of snapping (the command palette as you type, a dialog
 * whose body loads).
 *
 * Two elements: ``outer`` clips, ``inner`` holds the content at its natural
 * height. When the inner box resizes, the outer one animates its height from
 * where it is drawn to the new one at ``fast`` (``ease-out``), then lets go
 * (``height: auto`` again). A change mid-glide starts from the drawn height,
 * so typing quickly never jumps. Height is a layout property: this is for
 * small, isolated boxes only (DESIGN.md → Motion lists them).
 *
 * The first size is taken as is (the box opened at it); reduced motion and
 * a missing Web Animations API snap.
 */
import { useLayoutEffect, type RefObject } from 'react'
import { prefersReducedMotion } from '@/components/ui/_use-presence-motion'
import { DURATIONS_S, EASINGS, cssEasing } from '@/lib/motion'

/**
 * ``mounted``: pass the flag that mounts the two elements when they come and
 * go with the component (a dialog's body), so the observer attaches then.
 */
export function useHeightGlide(
  outer: RefObject<HTMLElement | null>,
  inner: RefObject<HTMLElement | null>,
  mounted = true,
): void {
  useLayoutEffect(() => {
    if (!mounted) return
    const box = outer.current
    const content = inner.current
    if (!box || !content || typeof ResizeObserver === 'undefined' || typeof box.animate !== 'function') return
    let last: number | null = null
    let running: Animation | null = null
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight
      if (last === null || next === last || prefersReducedMotion()) {
        last = next
        return
      }
      const from = running ? box.getBoundingClientRect().height : last
      last = next
      running?.cancel()
      const anim = box.animate([{ height: `${from}px` }, { height: `${next}px` }], {
        duration: DURATIONS_S.fast * 1000,
        easing: cssEasing(EASINGS.out),
      })
      anim.finished.then(() => { if (running === anim) running = null }, () => {})
      running = anim
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      running?.cancel()
    }
  }, [outer, inner, mounted])
}

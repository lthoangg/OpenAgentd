/**
 * useSlidingHighlight — one highlight pill behind a keyed list (the command
 * palette) that glides from row to row when the arrow keys move it, and
 * lands at once for everything else: typing (the rows themselves changed),
 * the pointer, a page change. Rows keep their own text inversion; the
 * active row's own fill steps aside while the pill is drawn
 * (``.oa-slide-list[data-pill]`` in index.css).
 *
 * The pill lives inside the scroller, so it scrolls with the rows. Call
 * ``glideNext()`` right before an arrow key changes the active row.
 * Reduced motion: always lands at once.
 */
import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react'
import { cssEasing, DURATIONS_S, EASINGS, prefersReducedMotion } from '@/lib/motion'

export function useSlidingHighlight(
  listRef: RefObject<HTMLElement | null>,
  pillRef: RefObject<HTMLElement | null>,
  activeSelector: string,
  /** Anything that changes which rows exist or where they sit. */
  layoutKey: unknown,
) {
  const glide = useRef(false)
  const last = useRef<{ top: number; height: number } | null>(null)
  const anim = useRef<Animation | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    const pill = pillRef.current
    const shouldGlide = glide.current
    glide.current = false
    if (!list || !pill) return
    const row = list.querySelector<HTMLElement>(activeSelector)
    if (!row) {
      pill.hidden = true
      list.removeAttribute('data-pill')
      last.current = null
      return
    }
    const listBox = list.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    const top = box.top - listBox.top + list.scrollTop
    const next = { top, height: box.height }
    // Start from where the pill is drawn now, so a held arrow key chains
    // glides instead of restarting each one.
    const drawn = anim.current?.playState === 'running'
      ? (() => {
          const b = pill.getBoundingClientRect()
          return { top: b.top - listBox.top + list.scrollTop, height: b.height }
        })()
      : last.current
    anim.current?.cancel()
    anim.current = null
    pill.hidden = false
    pill.style.top = `${next.top}px`
    pill.style.height = `${next.height}px`
    pill.style.left = `${box.left - listBox.left}px`
    pill.style.width = `${box.width}px`
    list.setAttribute('data-pill', '')
    last.current = next
    if (!shouldGlide || !drawn || prefersReducedMotion() || typeof pill.animate !== 'function') return
    if (drawn.top === next.top && drawn.height === next.height) return
    const a = pill.animate(
      [
        { transform: `translateY(${drawn.top - next.top}px)`, height: `${drawn.height}px` },
        { transform: 'translateY(0)', height: `${next.height}px` },
      ],
      { duration: DURATIONS_S.fast * 1000, easing: cssEasing(EASINGS.out) },
    )
    a.finished.catch(() => {})
    anim.current = a
  }, [listRef, pillRef, activeSelector, layoutKey])

  return { glideNext: useCallback(() => { glide.current = true }, []) }
}

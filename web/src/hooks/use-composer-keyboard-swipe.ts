import { useEffect, useRef, type RefObject } from 'react'

import { dismissKeyboard, isKeyboardUp } from '@/lib/soft-keyboard'

/** Travel (px) a swipe needs before its axis is decided. */
const SWIPE_AXIS_PX = 12
/** Vertical travel must beat horizontal by this much (as the edge swipes). */
const SWIPE_VERTICAL_DOMINANCE = 1.5
/** Upward travel (px) that asks for the keyboard. */
const SWIPE_OPEN_PX = 24
/** Where a swipe is not ours: the suggestion menus and the tray above the box. */
const SWIPE_IGNORE = '[role="listbox"], [data-composer-tray]'

/** A text field that can still scroll toward ``direction`` (it would take the swipe). */
function canScroll(field: HTMLTextAreaElement | null, direction: 'up' | 'down'): boolean {
  if (!field) return false
  return direction === 'up'
    ? field.scrollTop > 0
    : field.scrollTop + field.clientHeight < field.scrollHeight - 1
}

/**
 * The phone composer's keyboard swipe, as a chat app's: a swipe up on the
 * message box raises the soft keyboard (``focus``), a swipe down puts it
 * away. Vertical only, so a swipe from the left edge (Back) and a sideways
 * drag stay theirs; the message field keeps a swipe it can still scroll
 * with, and the suggestion menus and the tray above the box are left alone.
 * Not a drawer, so it does not go through ``use-edge-swipe``; like
 * ``useDismissKeyboardOnTouch`` it only listens (passive) and never blocks
 * a scroll.
 *
 * ``focus`` runs on ``touchend``: iOS raises the keyboard only for focus
 * given within a user gesture, and a touchmove is not one.
 *
 * A swipe the browser takes as a pan is not a user gesture either: it
 * cancels the pointer, the ``touchend`` carries no user activation, and the
 * focus lands without a keyboard (measured on Android Chrome). So the box
 * is marked ``data-keyboard-swipe`` and ``index.css`` lets the browser pan
 * it sideways only; the message field, a scroller of its own, keeps its
 * vertical pan only while it has lines to scroll (``data-swipe-scrolls``).
 */
export function useComposerKeyboardSwipe(
  ref: RefObject<HTMLElement | null>,
  { enabled, focus }: { enabled: boolean; focus: () => void },
) {
  const focusRef = useRef(focus)
  useEffect(() => { focusRef.current = focus })
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let start: { x: number; y: number; field: HTMLTextAreaElement | null } | null = null
    let axis: 'pending' | 'y' | 'other' = 'pending'

    // Whether the field scrolls is read before a touch starts: the browser
    // settles what it may pan from the style at touchstart, before any
    // listener could change it.
    const syncField = () => {
      const field = el.querySelector('textarea')
      field?.toggleAttribute('data-swipe-scrolls', field.scrollHeight > field.clientHeight + 1)
    }
    el.setAttribute('data-keyboard-swipe', '')
    syncField()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncField)
    const observed = el.querySelector('textarea')
    if (observed) resize?.observe(observed)

    const onStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const point = event.touches[0]
      if (event.touches.length !== 1 || !point || target?.closest(SWIPE_IGNORE)) {
        start = null
        return
      }
      start = { x: point.clientX, y: point.clientY, field: target?.closest('textarea') ?? null }
      axis = 'pending'
    }
    const onMove = (event: TouchEvent) => {
      const point = event.touches[0]
      if (!start || !point || axis === 'other') return
      const dx = point.clientX - start.x
      const dy = point.clientY - start.y
      if (axis === 'pending') {
        if (Math.hypot(dx, dy) < SWIPE_AXIS_PX) return
        axis = Math.abs(dy) > SWIPE_VERTICAL_DOMINANCE * Math.abs(dx) ? 'y' : 'other'
        if (axis === 'other') return
      }
      // Down with the keyboard up: put it away now, as the transcript does.
      if (dy > 0 && isKeyboardUp() && !canScroll(start.field, 'up')) {
        start = null
        dismissKeyboard()
      }
    }
    const onEnd = (event: TouchEvent) => {
      const from = start
      start = null
      syncField()
      const point = event.changedTouches?.[0]
      if (!from || !point || axis !== 'y' || isKeyboardUp()) return
      const dy = point.clientY - from.y
      if (dy > -SWIPE_OPEN_PX || canScroll(from.field, 'down')) return
      focusRef.current()
    }
    const onCancel = () => { start = null }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })
    el.addEventListener('input', syncField)
    el.addEventListener('focusin', syncField)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
      el.removeEventListener('input', syncField)
      el.removeEventListener('focusin', syncField)
      resize?.disconnect()
      el.removeAttribute('data-keyboard-swipe')
      el.querySelector('textarea')?.removeAttribute('data-swipe-scrolls')
    }
  }, [ref, enabled])
}

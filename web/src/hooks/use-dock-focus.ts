/**
 * Focus handoff between the chat and a review dock that can cover it.
 *
 * When the dock covers the chat (maximized, or a narrow window), the chat
 * column becomes ``inert`` and the browser drops any focus inside it onto
 * ``<body>``. DESIGN.md requires a visible replacement, so the dock claims
 * that stranded focus, and the shell hands it back to the composer when the
 * dock closes or stops covering the chat.
 */
import { useEffect, useRef } from 'react'

import { focusQuietly } from '@/lib/focus/quiet'
import { layerStack } from '@/lib/keyboard/layers'

/** Focus sits nowhere useful: on ``<body>``, or inside an inert subtree. */
export function isFocusStranded(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return !active || active === document.body || active.closest('[inert]') !== null
}

/**
 * While ``active``, move stranded focus to ``getTarget()``. ``key`` re-runs the
 * check when the target changes (for example another tab becomes active);
 * focus the user placed on a live control is never taken.
 */
export function useClaimStrandedFocus(active: boolean, key: string, getTarget: () => HTMLElement | null) {
  const getTargetRef = useRef(getTarget)
  useEffect(() => {
    getTargetRef.current = getTarget
  })
  useEffect(() => {
    if (!active || !isFocusStranded()) return
    // Quietly: the user's key press (⌘⇧D) did not steer focus to this tab,
    // so no ring, fill or tooltip until the keyboard moves on.
    const target = getTargetRef.current()
    if (target) focusQuietly(target)
  }, [active, key])
}

interface ReturnFocusOptions {
  open: boolean
  /** The dock covers the chat, which is inert underneath. */
  covered: boolean
  enabled: boolean
  isInDock: (element: Element) => boolean
  onReturn: () => void
}

/**
 * Call ``onReturn`` when the dock closes with focus inside it (it may still be
 * animating out), and when a dock that covered the chat closes or uncovers it
 * while focus is stranded. Focus the user moved elsewhere, such as the header
 * toggle, stays — and so does focus on ``<body>`` beside a side-by-side dock:
 * it sat there before the dock opened, so the dock stranded nothing.
 */
export function useReturnFocusFromDock({ open, covered, enabled, isInDock, onReturn }: ReturnFocusOptions) {
  const previousRef = useRef({ open, covered })
  const callbacksRef = useRef({ isInDock, onReturn })
  useEffect(() => {
    callbacksRef.current = { isInDock, onReturn }
  })
  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { open, covered }
    if (!enabled) return
    const closed = previous.open && !open
    const uncovered = previous.covered && !covered
    if (!closed && !uncovered) return
    const active = document.activeElement
    const leavingDock = closed && active !== null && callbacksRef.current.isInDock(active)
    const strandedByDock = previous.covered && isFocusStranded()
    if (leavingDock || strandedByDock) callbacksRef.current.onReturn()
  }, [open, covered, enabled])
}

/**
 * Never leave keyboard focus on ``<body>``. A desktop app always has a
 * focused control; a web page drops focus whenever the focused element
 * goes away — the composer textarea disabling itself after a send or Esc,
 * a deleted row, a closed popover — and the next Tab then restarts at the
 * top of the page. When that happens, ``restore`` puts focus back (the
 * composer, without expanding it).
 *
 * Browsers drop focus without an event when the focused element is
 * disabled or removed, so the guard checks twice: after a ``focusout``
 * that leads nowhere, and on a Tab press that starts from ``<body>`` — the
 * moment a stranded focus would otherwise send Tab to the top of the page.
 *
 * Left alone: a dialog or overlay owns focus (it restores its own), the
 * window lost focus to another app, and a ``focusout`` caused by a pointer
 * press (a click on plain text or empty space; Tab from there still lands
 * on the composer).
 */
export function useStrandedFocusGuard(enabled: boolean, restore: () => void) {
  const restoreRef = useRef(restore)
  useEffect(() => {
    restoreRef.current = restore
  })
  useEffect(() => {
    if (!enabled) return undefined
    let frame: number | null = null
    let pointerAt = Number.NEGATIVE_INFINITY
    const stranded = () => document.hasFocus() && isFocusStranded()
      && !layerStack().some((layer) => layer.kind !== 'transient')
    const check = () => {
      frame = null
      if (stranded()) restoreRef.current()
    }
    const onPointerDown = () => {
      pointerAt = performance.now()
    }
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget !== null || performance.now() - pointerAt < 400) return
      if (frame === null) frame = requestAnimationFrame(check)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (!stranded()) return
      restoreRef.current()
      // The composer can be inert too (under a covering dock): then let Tab
      // run its native course rather than swallowing it.
      if (!isFocusStranded()) event.preventDefault()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [enabled])
}

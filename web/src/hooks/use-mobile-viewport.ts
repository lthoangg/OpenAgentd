import { useEffect, type RefObject } from 'react'

import { getPlatform } from '@/hooks/use-platform'
import { MOBILE_QUERY } from '@/hooks/use-mobile'
import { dismissKeyboard } from '@/lib/soft-keyboard'

export { dismissKeyboard }

/** Vertical travel (px) that turns a touch into a scroll (no longer a tap). */
const DRAG_DISMISS_PX = 12
/** ms after a dismiss during which the retracting keyboard's frames are held off. */
const DISMISS_SETTLE_MS = 900
const EDITABLE = 'input, textarea, select, [contenteditable="true"]'
const INTERACTIVE = `${EDITABLE}, button, a[href], label, summary, [role="button"], [role="radio"], [role="checkbox"], [role="option"], [role="menuitem"], [role="tab"]`

/**
 * Dismiss the soft keyboard from a scrolling surface with a tap on its plain
 * content while the keyboard is up. A drag only scrolls: the reader keeps
 * the keyboard to read the chat while typing (user request), and a swipe
 * down on the composer still puts it away. Touches that start in a text field keep the keyboard (an inline answer
 * box inside the transcript), and taps on controls are left to the control.
 */
export function useDismissKeyboardOnTouch(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startY: number | null = null
    let moved = false
    const keyboardUp = () => document.documentElement.hasAttribute('data-keyboard-open')

    const onStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!keyboardUp() || event.touches.length !== 1 || target?.closest(EDITABLE)) {
        startY = null
        return
      }
      startY = event.touches[0]?.clientY ?? null
      moved = false
    }
    // Past the slop it is a scroll, not a tap: the keyboard stays.
    const onMove = (event: TouchEvent) => {
      if (startY === null || moved) return
      const y = event.touches[0]?.clientY
      if (y === undefined || Math.abs(y - startY) < DRAG_DISMISS_PX) return
      moved = true
    }
    const onEnd = (event: TouchEvent) => {
      const tapped = startY !== null && !moved
      startY = null
      if (!tapped || !keyboardUp()) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(INTERACTIVE)) return
      dismissKeyboard()
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
    }
  }, [ref])
}

/**
 * Single source of truth for the mobile app shell's geometry.
 *
 * The hard problem on mobile WebViews (iOS WKWebView especially) is the soft
 * keyboard. The document is locked (`position: fixed`, `overflow: hidden`) so
 * the layout viewport does *not* shrink when the keyboard opens — the keyboard
 * just overlaps the bottom of the screen. The previous approach chased the
 * keyboard with per-component `padding-bottom` driven through React state +
 * rAF + polling, which re-rendered the whole composer subtree every frame and
 * felt laggy.
 *
 * This version binds the **entire app shell** to `window.visualViewport` with
 * two CSS custom properties written *imperatively* to `:root` (no React
 * re-render in the hot path):
 *
 *   --app-vh  → the visual viewport height (shrinks when the keyboard opens)
 *   --app-vt  → the visual viewport offsetTop (non-zero when the page is
 *               scrolled under a floating keyboard / pinch-zoom)
 *
 * `.mobile-viewport` (the shell) uses `height: var(--app-vh)` and
 * `transform: translateY(var(--app-vt))`, so the shell resizes to exactly the
 * visible region as one rigid unit. The composer is a normal bottom flex child
 * and therefore sits flush above the keyboard automatically — no per-element
 * padding math, no chasing, no extra renders.
 */
export function useMobileViewportGuards() {
  useEffect(() => {
    const { isTauri, os } = getPlatform()
    const isTouch = (navigator.maxTouchPoints ?? 0) > 0
    // Activate for the mobile Tauri shell (always), for any touch device in a
    // phone-sized viewport, and for touch-first tablets in a browser (iPad,
    // Android tablets): the composer is docked at the bottom of the chat
    // column in every layout, so binding the shell to the visual viewport is
    // what keeps it on the soft keyboard there too. A touchscreen laptop
    // driven by a mouse (fine pointer) keeps the desktop page.
    const isMobileViewport = window.matchMedia(MOBILE_QUERY).matches
    const isTouchFirst = window.matchMedia('(pointer: coarse)').matches
    const isMobileShell =
      (isTauri && (os === 'ios' || os === 'android')) ||
      (isTouch && !!window.visualViewport && (isMobileViewport || isTouchFirst))
    if (!isMobileShell) return

    const root = document.documentElement
    root.setAttribute('data-mobile-shell', os === 'android' ? 'android' : 'ios')

    const vv = window.visualViewport

    const scrollFocusedControlIntoView = (target: HTMLElement) => {
      const container = target.closest('.overflow-y-auto') as HTMLElement | null
      if (!container) return

      const containerRect = container.getBoundingClientRect()
      const controlRect = target.getBoundingClientRect()
      const visibleBottom = Math.min(containerRect.bottom, vv?.height ?? window.innerHeight)
      if (controlRect.top >= containerRect.top && controlRect.bottom <= visibleBottom) return

      // Scroll only when the focused control is genuinely clipped. Moving an
      // already-visible control makes dialogs, comboboxes, and chat panes jump
      // as the keyboard animates into view.
      container.scrollTop = Math.max(0, container.scrollTop + controlRect.top - containerRect.top - 20)
    }

    // ── Visual-viewport → CSS variable binding ──────────────────────────────
    // iOS WKWebView does NOT shrink the layout viewport for the soft keyboard
    // (no `interactive-widget` support) — only `window.visualViewport` changes.
    // So the lift has to come from JS. The trick for smoothness is to write the
    // CSS variables *synchronously* inside the VisualViewport event: WebKit
    // dispatches `resize`/`scroll` on the same cadence as the keyboard
    // animation, so a synchronous style write rides the animation frame. An rAF
    // wrapper only inserts a frame of lag and makes the shell visibly trail the
    // keyboard — which is the "not smooth" symptom.
    //
    //   --app-vh → visible height. `.mobile-viewport` binds `height` to it, so
    //              the shell shrinks to the visible region and the bottom-docked
    //              composer rides up on the keyboard via normal flexbox. The
    //              scroll content (AgentView) just gets a shorter scrollport —
    //              no expensive content reflow.
    //   --app-vt → visual viewport offsetTop, for the rare scrolled/zoomed case.
    const baselineLayoutHeight = window.innerHeight
    // When the keyboard last went away (focus left a field with it up).
    let dismissedAt = -Infinity
    const applyViewport = () => {
      const height = vv ? vv.height : window.innerHeight
      const top = vv ? vv.offsetTop : 0
      // Mid-dismiss (``data-vp-anim``): the shell is already gliding to full
      // height. The keyboard's retract frames report shorter heights and a
      // passing offsetTop; following them would yank the eased shell back
      // and slide the whole screen (on-device report). A focused field (the
      // keyboard coming back) ends the glide.
      const focused = document.activeElement
      const typing = focused instanceof HTMLElement && focused.matches('input, textarea, [contenteditable="true"]')
      if (root.hasAttribute('data-vp-anim') && !typing) return
      // Past the glide the keyboard may still be retracting (it is slower than
      // the glide). Its frames would shrink the shell back and then let it go
      // again, a flicker: until it is gone, or a field takes focus, hold.
      if (!typing && performance.now() - dismissedAt < DISMISS_SETTLE_MS && baselineLayoutHeight - (height + top) > 80) return
      // Detect keyboard occlusion relative to the shell's baseline layout
      // height captured before the keyboard opens. On some mobile WebViews,
      // `window.innerHeight` also shrinks with the keyboard, so comparing the
      // live values would collapse to ~0 and miss the keyboard entirely.
      const occlusion = baselineLayoutHeight - (height + top)
      const nextOpen = occlusion > 80
      root.style.setProperty('--app-vh', `${Math.round(height)}px`)
      // Keep the shell anchored at y=0 while the keyboard is open. Use the
      // newly-calculated state, not the previous event's state, so an iOS
      // offsetTop reported alongside the first keyboard resize cannot shift
      // the entire app for one frame.
      root.style.setProperty('--app-vt', `${Math.round(nextOpen ? 0 : top)}px`)
      // The attribute is the state, not a copy of it: ``dismissKeyboard``
      // removes it ahead of the viewport's own events, and a closure flag left
      // true would then never restore it when the keyboard comes back.
      if (nextOpen !== root.hasAttribute('data-keyboard-open')) {
        if (nextOpen) {
          root.setAttribute('data-keyboard-open', '')
          // Opening must stay frame-locked (no transition lag on the way up) —
          // the eased transition is only for the optimistic dismiss snap-back.
          root.removeAttribute('data-vp-anim')
        } else {
          root.removeAttribute('data-keyboard-open')
        }
      }

      if (nextOpen) {
        const active = document.activeElement
        if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) {
          scrollFocusedControlIntoView(active)
        }
      }
    }

    applyViewport()

    if (vv) {
      vv.addEventListener('resize', applyViewport)
      vv.addEventListener('scroll', applyViewport)
    }
    window.addEventListener('orientationchange', applyViewport)

    // ── Zoom / rubber-band guards (unchanged behaviour) ─────────────────────
    const preventGestureZoom = (event: Event) => {
      event.preventDefault()
    }

    let lastTouchEnd = 0
    const preventDoubleTapZoom = (event: TouchEvent) => {
      const now = Date.now()
      if (now - lastTouchEnd <= 300) {
        event.preventDefault()
      }
      lastTouchEnd = now
    }

    const preventPinchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault()
      }
    }

    const preventWindowScroll = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0)
      }
    }

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target
      if (!(target instanceof HTMLElement) || !target.matches('input, textarea, [contenteditable="true"]')) return
      if (root.hasAttribute('data-vp-anim')) {
        root.removeAttribute('data-vp-anim')
        applyViewport()
      }
      // Wait for the keyboard's viewport update, then move only genuinely
      // obscured controls. This keeps nested overlay scrollers stable.
      setTimeout(() => scrollFocusedControlIntoView(target), 120)
    }
    document.addEventListener('focusin', handleFocusIn)

    // The keyboard also leaves when focus does by itself: a tap elsewhere, a
    // swipe that scrolls. Take the same eased path as ``dismissKeyboard``
    // instead of chasing the retract frame by frame.
    const handleFocusOut = (e: FocusEvent) => {
      if (!root.hasAttribute('data-keyboard-open')) return
      const next = e.relatedTarget
      if (next instanceof HTMLElement && next.matches('input, textarea, [contenteditable="true"]')) return
      dismissedAt = performance.now()
      root.setAttribute('data-vp-anim', '')
      root.removeAttribute('data-keyboard-open')
      root.style.setProperty('--app-vh', `${Math.round(baselineLayoutHeight)}px`)
      root.style.setProperty('--app-vt', '0px')
      window.setTimeout(() => {
        root.removeAttribute('data-vp-anim')
        applyViewport()
      }, 320)
    }
    document.addEventListener('focusout', handleFocusOut)

    document.addEventListener('gesturestart', preventGestureZoom)
    document.addEventListener('gesturechange', preventGestureZoom)
    document.addEventListener('gestureend', preventGestureZoom)
    document.addEventListener('touchend', preventDoubleTapZoom, { passive: false })
    document.addEventListener('touchmove', preventPinchZoom, { passive: false })
    window.addEventListener('scroll', preventWindowScroll)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
      root.removeAttribute('data-mobile-shell')
      root.removeAttribute('data-keyboard-open')
      root.removeAttribute('data-vp-anim')
      root.style.removeProperty('--app-vh')
      root.style.removeProperty('--app-vt')
      if (vv) {
        vv.removeEventListener('resize', applyViewport)
        vv.removeEventListener('scroll', applyViewport)
      }
      window.removeEventListener('orientationchange', applyViewport)
      window.removeEventListener('scroll', preventWindowScroll)
      document.removeEventListener('gesturestart', preventGestureZoom)
      document.removeEventListener('gesturechange', preventGestureZoom)
      document.removeEventListener('gestureend', preventGestureZoom)
      document.removeEventListener('touchend', preventDoubleTapZoom)
      document.removeEventListener('touchmove', preventPinchZoom)
    }
  }, [])
}

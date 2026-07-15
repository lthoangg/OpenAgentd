import { useEffect } from 'react'

import { getPlatform } from '@/hooks/use-platform'
import { MOBILE_QUERY } from '@/hooks/use-mobile'

/**
 * Dismiss the soft keyboard and snap the app shell back to full height *now*.
 *
 * When the user blurs an input, iOS slides the keyboard down over ~250-300ms
 * and fires `visualViewport` events the whole way. If the shell just tracks
 * those frames it crawls back up with the keyboard, which reads as "slow".
 * Instead we:
 *   1. blur the active editable element (starts the dismiss),
 *   2. enable a one-shot eased transition on the shell (`data-vp-anim`),
 *   3. optimistically write the full layout height so the shell glides back
 *      immediately rather than chasing the keyboard down frame-by-frame.
 * The live `visualViewport` binding stays authoritative; this just front-runs
 * it for the dismiss case. The transition flag clears on the next interaction
 * (handled by the hook) so opening the keyboard stays frame-locked and snappy.
 */
export function dismissKeyboard(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) {
    active.blur()
  }
  const root = document.documentElement
  if (!root.hasAttribute('data-mobile-shell')) return
  root.setAttribute('data-vp-anim', '')
  root.removeAttribute('data-keyboard-open')
  // Optimistically expand to the full layout viewport; the live binding will
  // reconcile to the exact value as the keyboard finishes retracting.
  root.style.setProperty('--app-vh', `${Math.round(window.innerHeight)}px`)
  root.style.setProperty('--app-vt', '0px')
  // Drop the transition flag once the glide is done so a subsequent keyboard
  // open stays frame-locked. (Opening also clears it eagerly in the hook.)
  window.setTimeout(() => root.removeAttribute('data-vp-anim'), 320)
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
    // Activate for the mobile Tauri shell (always) or for any touch device
    // that is *currently* in a mobile-sized viewport. The media query is the
    // same one `useIsMobile` uses, so the layout mode (mobile vs desktop) and
    // the viewport-binding always agree — prevents split-brain on iPads and
    // large Android tablets where a landscape orientation push the width above
    // the 768px threshold and the layout switches to the desktop draggable bar
    // while this hook would otherwise still be manipulating --app-vh.
    const isMobileViewport = window.matchMedia(MOBILE_QUERY).matches
    const isMobileShell =
      (isTauri && (os === 'ios' || os === 'android')) ||
      (isTouch && !!window.visualViewport && isMobileViewport)
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
    let keyboardOpen = false
    const baselineLayoutHeight = window.innerHeight
    const applyViewport = () => {
      const height = vv ? vv.height : window.innerHeight
      const top = vv ? vv.offsetTop : 0
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
      if (nextOpen !== keyboardOpen) {
        keyboardOpen = nextOpen
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
      // Wait for the keyboard's viewport update, then move only genuinely
      // obscured controls. This keeps nested overlay scrollers stable.
      setTimeout(() => scrollFocusedControlIntoView(target), 120)
    }
    document.addEventListener('focusin', handleFocusIn)

    document.addEventListener('gesturestart', preventGestureZoom)
    document.addEventListener('gesturechange', preventGestureZoom)
    document.addEventListener('gestureend', preventGestureZoom)
    document.addEventListener('touchend', preventDoubleTapZoom, { passive: false })
    document.addEventListener('touchmove', preventPinchZoom, { passive: false })
    window.addEventListener('scroll', preventWindowScroll)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
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

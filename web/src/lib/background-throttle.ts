/**
 * Background UI Throttling
 *
 * When the window or tab is hidden or minimized, marks the root HTML element
 * with `data-app-hidden="true"` so CSS animations are paused, and provides
 * a centralized check to avoid wakeups for timers and display sync links
 * (CVDisplayLink on macOS, DirectComposition on Windows, X11/Wayland vsync on Linux).
 */

export function updateBackgroundThrottleState(): void {
  if (typeof document === 'undefined') return
  const isHidden = Boolean(document.hidden || document.visibilityState === 'hidden')
  if (isHidden) {
    document.documentElement.setAttribute('data-app-hidden', 'true')
  } else {
    document.documentElement.removeAttribute('data-app-hidden')
  }
}

export function initBackgroundThrottle(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {}
  }

  // Initial check
  updateBackgroundThrottleState()

  const onVisibilityChange = () => {
    updateBackgroundThrottleState()
  }

  const onPageHide = () => {
    document.documentElement.setAttribute('data-app-hidden', 'true')
  }

  const onPageShow = () => {
    updateBackgroundThrottleState()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
  }
}

export function isAppHidden(): boolean {
  if (typeof document === 'undefined') return false
  return Boolean(document.hidden || document.visibilityState === 'hidden' || document.documentElement.hasAttribute('data-app-hidden'))
}

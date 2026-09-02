import { useSyncExternalStore } from 'react'

/**
 * Runtime platform detection.
 *
 * `isTauri` — bundle is running inside a Tauri WebView (detected via
 * `window.__TAURI_INTERNALS__`, set before any app code runs).
 *
 * `os` — host OS family; reads `navigator.platform` with a fallback
 * to `navigator.userAgentData.platform` for browsers that have frozen
 * the legacy property.
 *
 * `isMacOverlay` — macOS + Tauri: the OS overlays the traffic-light
 * buttons over our WebView content when windowed, so chrome must
 * reserve a left inset (70px) and provide a manual drag region.
 * In macOS fullscreen, the OS hides the traffic lights, so
 * `isMacOverlay` resolves to false and the 70px space is reclaimed.
 */

export type OS = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown'

export interface PlatformInfo {
  isTauri: boolean
  os: OS
  isMacOverlay: boolean
  isFullscreen: boolean
}

interface UAClientHints {
  platform?: string
}

let isFullscreenState = typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((l) => l())
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function getFullscreenSnapshot(): boolean {
  return isFullscreenState
}

export function _setFullscreenState(val: boolean): void {
  if (isFullscreenState !== val) {
    isFullscreenState = val
    notify()
  }
}

if (typeof window !== 'undefined') {
  document.addEventListener('fullscreenchange', () => {
    _setFullscreenState(Boolean(document.fullscreenElement))
  })

  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow()
        void win.isFullscreen().then((fs) => _setFullscreenState(fs)).catch(() => {})
        void win.onResized(async () => {
          try {
            const fs = await win.isFullscreen()
            _setFullscreenState(fs)
          } catch {
            // Ignore errors in non-standard window contexts
          }
        }).catch(() => {})
      })
      .catch(() => {})
  }
}

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'unknown'

  const legacy = navigator.platform || ''
  const ua = navigator.userAgent || ''
  const maxTouch = navigator.maxTouchPoints ?? 0

  // iOS first — iPhone/iPod are unambiguous, but iPadOS 13+ masquerades as
  // desktop Safari and reports ``navigator.platform === "MacIntel"``. The
  // reliable tell-tale is a touch-capable "Mac": real Macs report
  // ``maxTouchPoints === 0``, iPads report > 1. Checking this *before* the
  // ``/Mac/`` branch is what keeps the soft-keyboard inset working in the
  // iOS WKWebView shell (otherwise it's misdetected as macOS and the
  // composer never lifts above the keyboard).
  if (/iPhone|iPad|iPod/i.test(legacy) || /iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Mac/i.test(legacy) && maxTouch > 1) return 'ios'
  if (/Mac/i.test(legacy)) return 'macos'
  if (/Win/i.test(legacy)) return 'windows'
  if (/Linux/i.test(legacy)) {
    // Android UAs include "Linux" — disambiguate before claiming Linux desktop.
    return /Android/i.test(ua) ? 'android' : 'linux'
  }
  if (/Android/i.test(ua)) return 'android'

  const uaData = (navigator as unknown as { userAgentData?: UAClientHints }).userAgentData
  const uaPlatform = uaData?.platform?.toLowerCase() ?? ''
  if (uaPlatform === 'macos') return 'macos'
  if (uaPlatform === 'windows') return 'windows'
  if (uaPlatform === 'linux') return 'linux'
  if (uaPlatform === 'android') return 'android'
  if (uaPlatform === 'ios') return 'ios'

  return 'unknown'
}

function detectTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Recomputed per call so tests can patch navigator / window between
// cases without busting the module cache. Cost is negligible.
function compute(fsState = isFullscreenState): PlatformInfo {
  const os = detectOS()
  const isTauri = detectTauri()
  const isFullscreen = fsState
  return {
    isTauri,
    os,
    isFullscreen,
    isMacOverlay: os === 'macos' && isTauri && !isFullscreen,
  }
}

export function usePlatform(): PlatformInfo {
  const isFullscreen = useSyncExternalStore(subscribe, getFullscreenSnapshot, () => false)
  return compute(isFullscreen)
}

/** Non-hook accessor for code paths that can't call hooks. */
export function getPlatform(): PlatformInfo {
  return compute()
}

/**
 * Whether the OS suspends this page's sockets while it is backgrounded.
 *
 * iOS and Android freeze background WebViews and drop their connections
 * without the page seeing an error, so a resume (visibility, pageshow,
 * online) must reconnect. Desktop and laptop browsers keep a localhost SSE
 * alive, and reconnecting there would tear down a healthy stream and trigger
 * the refetch that follows every open. This is an OS question, not a viewport
 * one: a narrow desktop window keeps its sockets, an iPad does not.
 */
export function backgroundSuspendsSockets(): boolean {
  const os = getPlatform().os
  return os === 'ios' || os === 'android'
}

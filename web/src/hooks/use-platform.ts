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
 * buttons over our WebView content, so chrome must reserve a left
 * inset and provide a manual drag region. This is the only platform
 * combination that needs special handling.
 */

export type OS = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown'

export interface PlatformInfo {
  isTauri: boolean
  os: OS
  isMacOverlay: boolean
}

interface UAClientHints {
  platform?: string
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
function compute(): PlatformInfo {
  const os = detectOS()
  const isTauri = detectTauri()
  return { isTauri, os, isMacOverlay: os === 'macos' && isTauri }
}

export function usePlatform(): PlatformInfo {
  return compute()
}

/** Non-hook accessor for code paths that can't call hooks. */
export function getPlatform(): PlatformInfo {
  return compute()
}

/**
 * Regression tests for ``detectOS`` via ``getPlatform``.
 *
 * The critical case: iPadOS 13+ inside the WKWebView shell reports
 * ``navigator.platform === "MacIntel"`` (it masquerades as desktop Safari).
 * Before the touch-points disambiguation it was misdetected as ``macos``,
 * which disabled the mobile viewport binding (``useMobileViewportGuards``)
 * and left the mobile composer stuck behind the soft keyboard. A
 * touch-capable "Mac" must resolve to ``ios`` so the shell binds to the
 * visual viewport.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { getPlatform } from '@/hooks/use-platform'

function setNavigator(platform: string, maxTouchPoints: number, userAgent?: string): void {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true, writable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true, writable: true })
  if (userAgent !== undefined) {
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true, writable: true })
  }
}

afterEach(() => {
  // Reset to benign defaults so cases don't leak.
  setNavigator('', 0, 'node')
})

describe('detectOS — iPadOS WKWebView masquerade', () => {
  it('treats touch-capable "MacIntel" as ios (iPadOS WKWebView)', () => {
    setNavigator('MacIntel', 5)
    expect(getPlatform().os).toBe('ios')
  })

  it('keeps a non-touch "MacIntel" as macos (real Mac)', () => {
    setNavigator('MacIntel', 0)
    expect(getPlatform().os).toBe('macos')
  })

  it('detects an explicit iPhone platform as ios', () => {
    setNavigator('iPhone', 5)
    expect(getPlatform().os).toBe('ios')
  })

  it('detects iOS from the user-agent when platform is empty', () => {
    setNavigator('', 5, 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit')
    expect(getPlatform().os).toBe('ios')
  })

  it('still detects Android', () => {
    setNavigator('Linux armv8l', 5, 'Mozilla/5.0 (Linux; Android 14)')
    expect(getPlatform().os).toBe('android')
  })

  it('still detects Linux desktop', () => {
    setNavigator('Linux x86_64', 0, 'Mozilla/5.0 (X11; Linux x86_64)')
    expect(getPlatform().os).toBe('linux')
  })
})

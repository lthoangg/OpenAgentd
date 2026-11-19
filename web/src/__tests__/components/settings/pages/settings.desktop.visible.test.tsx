/**
 * Settings lists Desktop in every desktop app. It used to need a notch or
 * a pet, so the Linux app had no such page; it has Startup now.
 */
import { describe, expect, it, mock } from 'bun:test'

let shell = true
let os = 'linux'

mock.module('@/lib/desktop-shell', () => ({ isDesktopShell: () => shell }))
mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri: shell, os, isMacOverlay: false }),
  usePlatform: () => ({ isTauri: shell, os, isMacOverlay: false }),
}))

const { hasDesktopSettings } = await import('@/components/settings/pages/settings.desktop')

describe('hasDesktopSettings', () => {
  it('is true in the desktop app on every system', () => {
    for (const system of ['linux', 'windows', 'macos']) {
      os = system
      expect(hasDesktopSettings()).toBe(true)
    }
  })

  it('is false in a browser', () => {
    shell = false
    expect(hasDesktopSettings()).toBe(false)
  })
})

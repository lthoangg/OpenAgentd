import { describe, expect, it, mock } from 'bun:test'

let platform = { isTauri: true, os: 'macos' }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform }))

const { hasInAppUpdates, updatesByPackage } = await import('@/lib/updater')

describe('hasInAppUpdates', () => {
  it('is on for macOS, Windows and Android, off for iOS, Linux and the browser', () => {
    platform = { isTauri: true, os: 'macos' }
    expect(hasInAppUpdates()).toBe(true)
    platform = { isTauri: true, os: 'windows' }
    expect(hasInAppUpdates()).toBe(true)
    platform = { isTauri: true, os: 'android' }
    expect(hasInAppUpdates()).toBe(true)
    platform = { isTauri: true, os: 'ios' }
    expect(hasInAppUpdates()).toBe(false)
    platform = { isTauri: true, os: 'linux' }
    expect(hasInAppUpdates()).toBe(false)
    platform = { isTauri: false, os: 'macos' }
    expect(hasInAppUpdates()).toBe(false)
  })

  it('names the Linux app as the one updated by its package', () => {
    platform = { isTauri: true, os: 'linux' }
    expect(updatesByPackage()).toBe(true)
    platform = { isTauri: false, os: 'linux' }
    expect(updatesByPackage()).toBe(false)
    platform = { isTauri: true, os: 'windows' }
    expect(updatesByPackage()).toBe(false)
  })
})

import { describe, expect, it, mock } from 'bun:test'

let platform = { isTauri: true, os: 'macos' }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform }))

const { hasInAppUpdates } = await import('@/lib/updater')

describe('hasInAppUpdates', () => {
  it('is on for desktop and Android, off for iOS and the browser', () => {
    platform = { isTauri: true, os: 'macos' }
    expect(hasInAppUpdates()).toBe(true)
    platform = { isTauri: true, os: 'android' }
    expect(hasInAppUpdates()).toBe(true)
    platform = { isTauri: true, os: 'ios' }
    expect(hasInAppUpdates()).toBe(false)
    platform = { isTauri: false, os: 'macos' }
    expect(hasInAppUpdates()).toBe(false)
  })
})

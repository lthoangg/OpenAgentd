import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let platformOs = 'ios'
let isTauri = true
let impactShouldReject = false
const impactCalls: string[] = []
const vibrateCalls: number[] = []

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false }),
  getPlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false }),
}))

mock.module('@tauri-apps/plugin-haptics', () => ({
  impactFeedback: (style: string) => {
    impactCalls.push(style)
    if (impactShouldReject) return Promise.reject(new Error('unavailable'))
    return Promise.resolve(null)
  },
}))

async function haptics(): Promise<typeof import('@/lib/haptics')> {
  return import('@/lib/haptics')
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  platformOs = 'ios'
  isTauri = true
  impactShouldReject = false
  impactCalls.length = 0
  vibrateCalls.length = 0
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (ms: number) => {
      vibrateCalls.push(ms)
      return true
    },
  })
})

afterEach(() => {
  delete (navigator as { vibrate?: unknown }).vibrate
})

describe('softHapticFeedback', () => {
  it('uses the native soft impact inside a touch shell', async () => {
    const { softHapticFeedback } = await haptics()

    softHapticFeedback()
    await flush()

    expect(impactCalls).toEqual(['soft'])
    expect(vibrateCalls).toEqual([])
  })

  it('falls back to navigator.vibrate when the plugin fails', async () => {
    impactShouldReject = true
    const { softHapticFeedback } = await haptics()

    softHapticFeedback()
    await flush()

    expect(vibrateCalls).toEqual([10])
  })

  it('does nothing outside the Tauri shell', async () => {
    isTauri = false
    const { softHapticFeedback } = await haptics()

    softHapticFeedback()
    await flush()

    expect(impactCalls).toEqual([])
    expect(vibrateCalls).toEqual([])
  })

  it('does nothing on desktop platforms', async () => {
    platformOs = 'macos'
    const { softHapticFeedback } = await haptics()

    softHapticFeedback()
    await flush()

    expect(impactCalls).toEqual([])
    expect(vibrateCalls).toEqual([])
  })
})

describe('mediumHapticFeedback', () => {
  it('uses the native medium impact inside a touch shell', async () => {
    const { mediumHapticFeedback } = await haptics()

    mediumHapticFeedback()
    await flush()

    expect(impactCalls).toEqual(['medium'])
    expect(vibrateCalls).toEqual([])
  })

  it('falls back to navigator.vibrate when the plugin fails', async () => {
    impactShouldReject = true
    const { mediumHapticFeedback } = await haptics()

    mediumHapticFeedback()
    await flush()

    expect(vibrateCalls).toEqual([20])
  })
})

describe('haptic (semantic wrapper)', () => {
  it("maps 'tick' to a soft impact", async () => {
    const { haptic } = await haptics()

    haptic('tick')
    await flush()

    expect(impactCalls).toEqual(['soft'])
  })

  it("maps 'select' to a soft impact", async () => {
    const { haptic } = await haptics()

    haptic('select')
    await flush()

    expect(impactCalls).toEqual(['soft'])
  })

  it("maps 'commit' to a medium impact", async () => {
    const { haptic } = await haptics()

    haptic('commit')
    await flush()

    expect(impactCalls).toEqual(['medium'])
  })

  it('defaults to a soft tick when called with no argument', async () => {
    const { haptic } = await haptics()

    haptic()
    await flush()

    expect(impactCalls).toEqual(['soft'])
  })
})

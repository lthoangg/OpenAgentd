import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let platformOs = 'android'
let isTauri = true
const invokeCalls: string[] = []
let backListener: ((payload: { canGoBack: boolean }) => void) | null = null
let unregisterCalls = 0

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false, isFullscreen: false }),
  getPlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false, isFullscreen: false }),
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: (command: string) => {
    invokeCalls.push(command)
    return Promise.resolve(null)
  },
}))

mock.module('@tauri-apps/api/app', () => ({
  onBackButtonPress: (handler: (payload: { canGoBack: boolean }) => void) => {
    backListener = handler
    return Promise.resolve({ unregister: () => { unregisterCalls += 1; return Promise.resolve() } })
  },
}))

const { handleBackPress, installAndroidBackButton, registerBackHandler, _resetBackHandlersForTests } = await import('@/lib/back-button')
const { pushLayer, removeLayer, _resetLayersForTests } = await import('@/lib/keyboard/layers')

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let historyBacks = 0
const originalBack = window.history.back

beforeEach(() => {
  platformOs = 'android'
  isTauri = true
  invokeCalls.length = 0
  backListener = null
  unregisterCalls = 0
  historyBacks = 0
  window.history.back = () => { historyBacks += 1 }
  _resetLayersForTests()
  _resetBackHandlersForTests()
})

afterEach(() => {
  window.history.back = originalBack
})

describe('handleBackPress', () => {
  it('goes back in history when nothing is open, as the default Back did', () => {
    expect(handleBackPress(true)).toBe('history')
    expect(historyBacks).toBe(1)
    expect(invokeCalls).toEqual([])
  })

  it('closes the top layer before touching history', () => {
    const closed: string[] = []
    pushLayer({ kind: 'dialog', close: () => closed.push('dialog') })
    pushLayer({ kind: 'transient', close: () => closed.push('menu') })

    expect(handleBackPress(true)).toBe('layer')
    expect(closed).toEqual(['menu'])
    expect(historyBacks).toBe(0)
  })

  it('closes the latest registered surface (a drawer) when no layer is open', () => {
    const closed: string[] = []
    registerBackHandler(() => closed.push('older'))
    const stop = registerBackHandler(() => closed.push('drawer'))

    expect(handleBackPress(true)).toBe('handler')
    expect(closed).toEqual(['drawer'])

    stop()
    expect(handleBackPress(true)).toBe('handler')
    expect(closed).toEqual(['drawer', 'older'])
    expect(historyBacks).toBe(0)
  })

  it('prefers layers over drawers', () => {
    const closed: string[] = []
    registerBackHandler(() => closed.push('drawer'))
    const id = pushLayer({ kind: 'overlay', close: () => closed.push('palette') })

    handleBackPress(true)
    removeLayer(id)
    handleBackPress(true)

    expect(closed).toEqual(['palette', 'drawer'])
  })

  it('backgrounds the app on the first screen instead of quitting', async () => {
    expect(handleBackPress(false)).toBe('background')
    await flush()

    expect(invokeCalls).toEqual(['app_move_to_background'])
    expect(historyBacks).toBe(0)
  })
})

describe('installAndroidBackButton', () => {
  it('takes over Back inside the Android shell', async () => {
    const stop = installAndroidBackButton()
    await flush()

    expect(backListener).not.toBeNull()
    backListener?.({ canGoBack: true })
    expect(historyBacks).toBe(1)

    stop()
    await flush()
    expect(unregisterCalls).toBe(1)
  })

  it('leaves Back alone on iOS, desktop, and in browsers', async () => {
    platformOs = 'ios'
    installAndroidBackButton()
    platformOs = 'android'
    isTauri = false
    installAndroidBackButton()
    await flush()

    expect(backListener).toBeNull()
  })
})

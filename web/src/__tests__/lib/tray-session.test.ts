import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let calls: Array<[string, unknown]> = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.push([cmd, args])
  },
}))

const { setTraySession } = await import('@/lib/tray')

const realPlatform = navigator.platform
const onPlatform = (value: string) => Object.defineProperty(navigator, 'platform', { value, configurable: true })

beforeEach(() => {
  calls = []
  window.__TAURI_INTERNALS__ = {}
})
afterEach(() => {
  delete window.__TAURI_INTERNALS__
  onPlatform(realPlatform)
})

describe('setTraySession', () => {
  it('names the session in the tray menu on Windows and Linux', async () => {
    onPlatform('Win32')
    await setTraySession('Chat: Refactor auth')
    expect(calls).toEqual([['set_tray_session', { text: 'Chat: Refactor auth' }]])
  })

  // The Mac tray is the popup: it has no menu row to rename.
  it('sends nothing on a Mac, whose tray has no session row', async () => {
    onPlatform('MacIntel')
    await setTraySession('Chat: Refactor auth')
    expect(calls).toEqual([])
  })

  it('sends nothing outside the desktop app', async () => {
    delete window.__TAURI_INTERNALS__
    onPlatform('Win32')
    await setTraySession('Chat')
    expect(calls).toEqual([])
  })
})

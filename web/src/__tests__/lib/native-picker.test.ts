import { beforeEach, describe, expect, it, mock } from 'bun:test'

let platformOs = 'ios'
let isTauri = true
let invokeResult: unknown = null
let invokeShouldReject = false
const invokeCalls: Array<{ command: string; args: unknown }> = []

const realPlatform = await import('@/hooks/use-platform')
mock.module('@/hooks/use-platform', () => ({
  ...realPlatform,
  usePlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false, isFullscreen: false }),
  getPlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false, isFullscreen: false }),
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args })
    return invokeShouldReject ? Promise.reject(new Error('no picker')) : Promise.resolve(invokeResult)
  },
}))

const { pickNative } = await import('@/lib/native-picker')

const OPTIONS = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

beforeEach(() => {
  platformOs = 'ios'
  isTauri = true
  invokeResult = null
  invokeShouldReject = false
  invokeCalls.length = 0
})

describe('pickNative', () => {
  it('asks the shell to pick one and returns the chosen id', async () => {
    invokeResult = 'dark'
    expect(await pickNative('Theme', OPTIONS, 'light')).toBe('dark')
    expect(invokeCalls).toEqual([
      { command: 'pick_one', args: { title: 'Theme', options: OPTIONS, selected: 'light' } },
    ])
  })

  it('works on Android too', async () => {
    platformOs = 'android'
    invokeResult = 'light'
    expect(await pickNative('Theme', OPTIONS)).toBe('light')
  })

  it('omits selected when there is none, and sends only id and label', async () => {
    await pickNative('Theme', [{ id: 'a', label: 'A', extra: 1 } as { id: string; label: string }])
    expect(invokeCalls[0].args).toEqual({ title: 'Theme', options: [{ id: 'a', label: 'A' }] })
  })

  it('returns null when the user dismisses the picker', async () => {
    invokeResult = null
    expect(await pickNative('Theme', OPTIONS, 'light')).toBeNull()
  })

  it('returns undefined, without calling the shell, outside the mobile shell', async () => {
    isTauri = false
    expect(await pickNative('Theme', OPTIONS)).toBeUndefined()
    isTauri = true
    platformOs = 'windows'
    expect(await pickNative('Theme', OPTIONS)).toBeUndefined()
    expect(invokeCalls).toEqual([])
  })

  it('returns undefined for an empty list rather than showing an empty sheet', async () => {
    expect(await pickNative('Theme', [])).toBeUndefined()
    expect(invokeCalls).toEqual([])
  })

  it('returns undefined, not null, when the command fails, so the caller shows its own UI', async () => {
    invokeShouldReject = true
    expect(await pickNative('Theme', OPTIONS)).toBeUndefined()
  })
})

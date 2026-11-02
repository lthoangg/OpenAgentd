import { beforeEach, describe, expect, it, mock } from 'bun:test'

let platformOs = 'ios'
let isTauri = true
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
    return invokeShouldReject ? Promise.reject(new Error('no share sheet')) : Promise.resolve(null)
  },
}))

const { shareOnMobile } = await import('@/lib/mobile-share')

beforeEach(() => {
  platformOs = 'ios'
  isTauri = true
  invokeShouldReject = false
  invokeCalls.length = 0
})

describe('shareOnMobile', () => {
  it('opens the native share sheet with the link and title on iOS', async () => {
    expect(await shareOnMobile('https://box.example/s/1', 'My session')).toBe(true)
    expect(invokeCalls).toEqual([
      { command: 'share_text', args: { url: 'https://box.example/s/1', title: 'My session' } },
    ])
  })

  it('works on Android too', async () => {
    platformOs = 'android'
    expect(await shareOnMobile('https://box.example/s/1')).toBe(true)
    expect(invokeCalls).toHaveLength(1)
  })

  it('leaves the title out when there is none or it is empty', async () => {
    await shareOnMobile('https://box.example/s/1')
    await shareOnMobile('https://box.example/s/2', '')
    expect(invokeCalls.map((c) => c.args)).toEqual([
      { url: 'https://box.example/s/1' },
      { url: 'https://box.example/s/2' },
    ])
  })

  it('reports false, without calling the shell, outside the mobile shell', async () => {
    isTauri = false
    expect(await shareOnMobile('https://box.example/s/1')).toBe(false)
    isTauri = true
    platformOs = 'macos'
    expect(await shareOnMobile('https://box.example/s/1')).toBe(false)
    expect(invokeCalls).toEqual([])
  })

  it('reports false instead of rejecting when the command fails', async () => {
    invokeShouldReject = true
    expect(await shareOnMobile('https://box.example/s/1')).toBe(false)
    expect(invokeCalls).toHaveLength(1)
  })
})

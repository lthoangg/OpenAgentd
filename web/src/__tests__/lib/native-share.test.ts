import { beforeEach, describe, expect, it, mock } from 'bun:test'

let platform: { isTauri: boolean; os: string } = { isTauri: true, os: 'macos' }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform }))

let invokeResult: () => Promise<unknown> = async () => undefined
const invoke = mock(async (..._args: unknown[]) => invokeResult())
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { canShareNatively, lastPressPoint, shareNative } = await import('@/lib/native-share')
const { canShareSession, shareSessionLink } = await import('@/lib/session-link')

beforeEach(() => {
  platform = { isTauri: true, os: 'macos' }
  invokeResult = async () => undefined
  invoke.mockClear()
})

describe('canShareNatively', () => {
  const cases: [string, boolean, boolean][] = [
    ['macos', true, true],
    ['windows', true, true],
    ['linux', true, false],
    ['ios', true, false],
    ['android', true, false],
    ['macos', false, false],
  ]
  it.each(cases)('on %s (tauri %s) is %s', (os, isTauri, expected) => {
    platform = { isTauri, os }
    expect(canShareNatively()).toBe(expected)
  })
})

describe('shareNative', () => {
  it('shows the share sheet for the link, anchored at the point', async () => {
    expect(await shareNative('openagentd://session/abc', 'Fix updater', { x: 40, y: 90 })).toBe(true)

    expect(invoke.mock.calls).toEqual([['share_url', { url: 'openagentd://session/abc', title: 'Fix updater', x: 40, y: 90 }]])
  })

  it('anchors at the last press when no point is given', async () => {
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 210, clientY: 330, bubbles: true }))
    expect(lastPressPoint()).toEqual({ x: 210, y: 330 })

    await shareNative('https://example.com/a', 'A')

    expect(invoke.mock.calls[0]).toEqual(['share_url', { url: 'https://example.com/a', title: 'A', x: 210, y: 330 }])
  })

  it('says no where there is no native share sheet, without asking the shell', async () => {
    platform = { isTauri: true, os: 'linux' }
    expect(await shareNative('https://example.com/a', 'A', { x: 1, y: 1 })).toBe(false)
    platform = { isTauri: false, os: 'macos' }
    expect(await shareNative('https://example.com/a', 'A', { x: 1, y: 1 })).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('says no when the shell refuses', async () => {
    invokeResult = async () => {
      throw new Error('unsupported')
    }
    expect(await shareNative('https://example.com/a', 'A', { x: 1, y: 1 })).toBe(false)
  })
})

describe('shareSessionLink in the desktop app', () => {
  const session = { id: 'abc def', title: 'Fix updater' }
  const originalShare = navigator.share
  const originalClipboard = navigator.clipboard
  const writeText = mock(async (..._args: unknown[]) => {})

  beforeEach(() => {
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true, writable: true })
  })

  function restore() {
    Object.defineProperty(navigator, 'share', { value: originalShare, configurable: true, writable: true })
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
  }

  it('uses the native share sheet first', async () => {
    try {
      const outcome = await shareSessionLink(session, true, { x: 5, y: 6 })

      expect(outcome).toBe('shared')
      expect(invoke.mock.calls).toEqual([['share_url', { url: 'openagentd://session/abc%20def', title: 'Fix updater', x: 5, y: 6 }]])
      expect(writeText).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('copies the link on Linux, which has no share sheet', async () => {
    platform = { isTauri: true, os: 'linux' }
    try {
      expect(await shareSessionLink(session, true)).toBe('copied')
      expect(writeText.mock.calls).toEqual([['openagentd://session/abc%20def']])
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('falls back to Web Share, then to copying, when the shell cannot share', async () => {
    invokeResult = async () => {
      throw new Error('unsupported')
    }
    const share = mock(async (..._args: unknown[]) => {})
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true })
    try {
      expect(await shareSessionLink(session, true)).toBe('shared')
      expect(share).toHaveBeenCalledTimes(1)
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true, writable: true })
      expect(await shareSessionLink(session, true)).toBe('copied')
    } finally {
      restore()
    }
  })
})

describe('shareSessionLink in the phone apps', () => {
  const session = { id: 'abc', title: 'Fix updater' }
  const originalShare = navigator.share
  const originalClipboard = navigator.clipboard
  const writeText = mock(async (..._args: unknown[]) => {})

  beforeEach(() => {
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    // Android's WebView has no Web Share at all.
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true, writable: true })
  })

  function restore() {
    Object.defineProperty(navigator, 'share', { value: originalShare, configurable: true, writable: true })
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
  }

  it.each(['ios', 'android'])('offers Share… and opens the system share sheet on %s', async (os) => {
    platform = { isTauri: true, os }
    try {
      expect(canShareSession()).toBe(true)
      expect(await shareSessionLink(session, true)).toBe('shared')
      expect(invoke.mock.calls).toEqual([['share_text', { url: 'openagentd://session/abc', title: 'Fix updater' }]])
      expect(writeText).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('copies the link when the phone shell cannot share', async () => {
    platform = { isTauri: true, os: 'android' }
    invokeResult = async () => {
      throw new Error('unsupported')
    }
    try {
      expect(await shareSessionLink(session, true)).toBe('copied')
      expect(writeText.mock.calls).toEqual([['openagentd://session/abc']])
    } finally {
      restore()
    }
  })
})

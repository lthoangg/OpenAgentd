import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let platform: { isTauri: boolean; os: string } = { isTauri: true, os: 'macos' }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform }))

let invokeResult: () => Promise<unknown> = async () => null
const invoke = mock(async (..._args: unknown[]) => invokeResult())
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { createAltTapDetector, hasAppMenuButton, showAppMenu, showNativeMenu } = await import('@/lib/native-menu')

beforeEach(() => {
  platform = { isTauri: true, os: 'macos' }
  invokeResult = async () => null
  invoke.mockClear()
})

const ITEMS = [
  { id: 'rename', label: 'Rename' },
  { separator: true as const },
  { id: 'pin', label: 'Pinned', checked: true, enabled: false },
]

describe('showNativeMenu', () => {
  it('hands the items and the point to the shell and resolves with the chosen id', async () => {
    invokeResult = async () => 'rename'

    expect(await showNativeMenu(ITEMS, { x: 120, y: 48 })).toBe('rename')

    expect(invoke.mock.calls).toEqual([['show_context_menu', { items: ITEMS, x: 120, y: 48 }]])
  })

  it('resolves null when the menu was dismissed', async () => {
    invokeResult = async () => null
    expect(await showNativeMenu(ITEMS, { x: 0, y: 0 })).toBeNull()
  })

  it.each(['windows', 'linux'])('shows the menu in the %s desktop app too', async (os) => {
    platform = { isTauri: true, os }
    invokeResult = async () => 'pin'
    expect(await showNativeMenu(ITEMS, { x: 1, y: 2 })).toBe('pin')
  })

  it('answers undefined in a browser, so the caller shows its own menu', async () => {
    platform = { isTauri: false, os: 'macos' }
    expect(await showNativeMenu(ITEMS, { x: 1, y: 2 })).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('answers undefined in the phone apps', async () => {
    platform = { isTauri: true, os: 'ios' }
    expect(await showNativeMenu(ITEMS, { x: 1, y: 2 })).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('answers undefined when the shell cannot show it, so the caller falls back', async () => {
    invokeResult = async () => {
      throw new Error('unknown command')
    }
    expect(await showNativeMenu(ITEMS, { x: 1, y: 2 })).toBeUndefined()
  })
})

describe('the application menu button', () => {
  const cases: [string, boolean, boolean][] = [
    ['windows', true, true],
    ['linux', true, true],
    ['macos', true, false],
    ['ios', true, false],
    ['windows', false, false],
  ]
  it.each(cases)('on %s (tauri %s) is %s', (os, isTauri, expected) => {
    platform = { isTauri, os }
    expect(hasAppMenuButton()).toBe(expected)
  })

  it('pops the menu up at the point in the Windows and Linux apps', async () => {
    platform = { isTauri: true, os: 'windows' }

    expect(await showAppMenu({ x: 12, y: 36 })).toBe(true)

    expect(invoke.mock.calls).toEqual([['show_app_menu', { x: 12, y: 36 }]])
  })

  it('has no menu to pop up on macOS, where the menu bar is the menu', async () => {
    expect(await showAppMenu({ x: 12, y: 36 })).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports a menu the shell could not show', async () => {
    platform = { isTauri: true, os: 'linux' }
    invokeResult = async () => {
      throw new Error('no menu')
    }
    expect(await showAppMenu({ x: 0, y: 0 })).toBe(false)
  })
})

describe('a bare Alt tap', () => {
  let taps = 0
  let alt: ReturnType<typeof createAltTapDetector>

  beforeEach(() => {
    taps = 0
    alt = createAltTapDetector(() => {
      taps += 1
    })
    document.body.innerHTML = '<input id="field" /><button id="button">Go</button>'
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const down = (key: string, init: KeyboardEventInit = {}) => alt.onKeyDown(new KeyboardEvent('keydown', { key, ...init }))
  const up = (key: string, init: KeyboardEventInit = {}) => alt.onKeyUp(new KeyboardEvent('keyup', { key, ...init }))

  it('opens the menu when Alt goes down and up with nothing between', () => {
    down('Alt', { altKey: true })
    up('Alt')
    expect(taps).toBe(1)
  })

  it('does not open when another key came between: Alt is part of a shortcut', () => {
    down('Alt', { altKey: true })
    down('f', { altKey: true })
    up('f')
    up('Alt')
    expect(taps).toBe(0)
  })

  it('does not open for Alt held with Ctrl, Meta or Shift', () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      down('Alt', { altKey: true, ...init })
      up('Alt')
    }
    expect(taps).toBe(0)
  })

  it('does not open after a mouse press (Alt+click) or when the window loses focus (Alt+Tab)', () => {
    down('Alt', { altKey: true })
    alt.onPointerDown()
    up('Alt')
    down('Alt', { altKey: true })
    alt.onBlur()
    up('Alt')
    expect(taps).toBe(0)
  })

  it('leaves the tap to a text field that has focus', () => {
    ;(document.getElementById('field') as HTMLInputElement).focus()
    down('Alt', { altKey: true })
    up('Alt')
    expect(taps).toBe(0)
  })

  it('still opens while a button has focus', () => {
    ;(document.getElementById('button') as HTMLButtonElement).focus()
    down('Alt', { altKey: true })
    up('Alt')
    expect(taps).toBe(1)
  })

  it('ignores a key release it never saw go down, and held-key repeats', () => {
    up('Alt')
    expect(taps).toBe(0)
    down('Alt', { altKey: true })
    down('x')
    down('Alt', { altKey: true, repeat: true })
    up('Alt')
    expect(taps).toBe(0)
  })

  it('opens again on the next tap', () => {
    for (let i = 0; i < 2; i += 1) {
      down('Alt', { altKey: true })
      up('Alt')
    }
    expect(taps).toBe(2)
  })
})

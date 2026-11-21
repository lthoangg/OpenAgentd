/**
 * TerminalView end to end in the DOM: the real view (the app-wide stub is
 * bypassed with ``?real``) over the real store, with a fake xterm and socket.
 * Covers the flows a person uses: right-click with a mouse, long press then
 * Select Text on touch, the touch gestures (scroll, hold and drag, double
 * tap, pinch), the key bar's two layouts and More, and the command field.
 */
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const fn = (impl: (...args: never[]) => unknown) => mock(impl as unknown as (...args: unknown[]) => unknown)

// ── A fake xterm: a buffer of rows, a selection, paste through onData ───────
const ROWS = ['$ cargo test', 'test a ... ok', 'test b ... FAILED', 'assertion failed: x == 1', '$']
let typed: ((data: string) => void) | null = null
let selection = ''
const term = {
  element: undefined as HTMLElement | undefined,
  options: {} as Record<string, unknown>,
  rows: 24,
  cols: 80,
  modes: { mouseTrackingMode: 'none' },
  scrollLines: fn((_lines: number) => {}),
  scrollToBottom: fn(() => {}),
  write: fn(() => {}),
  dispose: fn(() => {}),
  focus: fn(() => {}),
  blur: fn(() => {}),
  clear: fn(() => {}),
  open: fn((el: HTMLElement) => {
    term.element = document.createElement('div')
    el.appendChild(term.element)
  }),
  onData: fn((handler: (data: string) => void) => { typed = handler }),
  paste: fn((text: string) => typed?.(text)),
  hasSelection: () => selection !== '',
  getSelection: () => selection,
  selectAll: fn(() => { selection = ROWS.join('\n') }),
  clearSelection: fn(() => { selection = '' }),
  onSelectionChange: () => ({ dispose: () => {} }),
  buffer: {
    active: {
      type: 'normal' as 'normal' | 'alternate',
      length: ROWS.length,
      viewportY: 0,
      getLine: (y: number) => (ROWS[y] === undefined ? undefined : { isWrapped: false, translateToString: () => ROWS[y]! }),
    },
  },
}

mock.module('@/components/Terminal/xterm-instance', () => ({
  createXterm: (options: { fontSize: number }) => {
    term.options.fontSize = options.fontSize
    return { term, fit: { fit: () => {} }, onFindRequest: () => () => {}, setFileOpener: () => {} }
  },
}))

const sent: string[] = []
mock.module('@/api/terminal', () => ({
  connectTerminal: fn(async () => ({
    protocol: 1,
    sendInput: (data: string) => { sent.push(data) },
    sendResize: () => {},
    close: () => {},
  })),
}))

const { useTerminalStore, _resetTerminalStoreForTests } = await import('@/stores/useTerminalStore')
// The real view: setup.ts stubs '@/components/Terminal/TerminalView' app-wide,
// and a query string is a different module to the registry.
const REAL_VIEW: string = '../../../components/Terminal/TerminalView.tsx?real'
const { TerminalView } = (await import(REAL_VIEW)) as typeof import('@/components/Terminal/TerminalView')
const { onComposerInsert } = await import('@/lib/composer-insert')
const { TERMINAL_COMMAND_FIELD_KEY } = await import('@/components/Terminal/TerminalCommandField')
const { useDisplayPrefsStore } = await import('@/stores/useDisplayPrefsStore')

const realMatchMedia = window.matchMedia
/** A phone (narrow, touch) or a desktop window (wide, mouse). */
function device(kind: 'phone' | 'desktop') {
  window.matchMedia = ((query: string) => ({
    matches: kind === 'phone',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

async function openTerminal() {
  const id = useTerminalStore.getState().open({ workspace: '/repo' }, '/repo')
  render(<TerminalView sessionId={id} />)
  await waitFor(() => expect(useTerminalStore.getState().sessions[id]?.shellState.kind).toBe('connected'))
  return id
}

/** The soft keyboard up or down, as the mobile viewport guards mark it. */
function keyboard(open: boolean) {
  if (open) document.documentElement.setAttribute('data-keyboard-open', '')
  else document.documentElement.removeAttribute('data-keyboard-open')
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

/** A finger on the terminal surface. */
function touch(type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number, pointerId = 1) {
  fireEvent[type](screen.getByTestId('terminal-surface'), { pointerType: 'touch', pointerId, clientX: x, clientY: y })
}

beforeEach(() => {
  _resetTerminalStoreForTests()
  sent.length = 0
  selection = ''
  term.element = undefined
  term.buffer.active.type = 'normal'
  term.scrollLines.mockClear()
  localStorage.removeItem(TERMINAL_COMMAND_FIELD_KEY)
  useDisplayPrefsStore.setState({ terminalFontPx: null })
  keyboard(false)
})
afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
  window.getSelection()?.removeAllRanges()
})

describe('desktop: right-click in the terminal', () => {
  it("opens the terminal's own menu, and its rows act on the terminal", async () => {
    device('desktop')
    await openTerminal()
    const surface = screen.getByTestId('terminal-surface')
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
    act(() => { surface.dispatchEvent(event) })
    // The webview's own menu is suppressed.
    expect(event.defaultPrevented).toBe(true)
    expect(screen.getAllByRole('menuitem')).toHaveLength(6)
    expect(screen.queryByRole('menuitem', { name: /Select Text/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Select All/ }))
    expect(term.selectAll).toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()

    act(() => { surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    fireEvent.click(screen.getByRole('menuitem', { name: /Clear/ }))
    expect(term.clear).toHaveBeenCalled()
  })

  it('shows no key bar', async () => {
    device('desktop')
    await openTerminal()
    expect(screen.queryByRole('toolbar', { name: 'Terminal keys' })).toBeNull()
  })
})

describe('phone: select part of the output', () => {
  it('long press → Select Text → native selection → Add to chat', async () => {
    device('phone')
    await openTerminal()
    const surface = screen.getByTestId('terminal-surface')
    fireEvent.pointerDown(surface, { pointerType: 'touch', clientX: 20, clientY: 20 })
    // Held past the long-press threshold.
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
    fireEvent.pointerUp(surface, { pointerType: 'touch' })
    // A tap of its own (a press, then the click): the release's click is swallowed.
    const selectText = await screen.findByRole('button', { name: 'Select Text' })
    fireEvent.pointerDown(selectText, { pointerType: 'touch' })
    fireEvent.click(selectText)

    // The output as text, nothing selected yet; the soft keyboard goes away.
    const text = await screen.findByTestId('terminal-text')
    expect(text.querySelectorAll('[data-line]')).toHaveLength(ROWS.length)
    expect(term.blur).toHaveBeenCalled()

    // Two lines from the middle, as a finger would select them.
    const from = text.querySelector('[data-line="2"]')!
    const to = text.querySelector('[data-line="3"]')!
    const range = document.createRange()
    range.setStart(from.firstChild!, 0)
    range.setEnd(to.firstChild!, to.textContent!.length)
    act(() => {
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    const inserted: string[] = []
    const off = onComposerInsert((block) => inserted.push(block))
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    } finally {
      off()
    }
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toContain('test b ... FAILED')
    expect(inserted[0]).toContain('assertion failed: x == 1')
    expect(inserted[0]).not.toContain('test a ... ok')
    // Back to the live terminal.
    expect(screen.queryByTestId('terminal-text')).toBeNull()
  })
})

describe('phone: key bar and command field', () => {
  it('sends Ctrl+← as a word jump and releases Ctrl', async () => {
    device('phone')
    keyboard(true)
    await openTerminal()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }))
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Arrow left' }))
    expect(sent).toEqual(['\x1b[1;5D'])
    expect(screen.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false')
  })

  it("long press → Paste goes through xterm's paste, so several lines go in as one paste", async () => {
    device('phone')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'one\ntwo\nthree' },
    })
    await openTerminal()
    touch('pointerDown', 20, 20)
    await wait(600)
    touch('pointerUp', 20, 20)
    const paste = await screen.findByRole('button', { name: 'Paste' })
    await act(async () => {
      fireEvent.pointerDown(paste, { pointerType: 'touch' })
      fireEvent.click(paste)
    })
    expect(term.paste).toHaveBeenCalledWith('one\ntwo\nthree')
  })

  it('Line turns on the command field, whose Return sends the line with Enter', async () => {
    device('phone')
    keyboard(true)
    await openTerminal()
    fireEvent.click(screen.getByRole('button', { name: 'Command line field' }))
    const field = screen.getByRole('textbox', { name: 'Command' })
    fireEvent.change(field, { target: { value: 'echo "xin chào"' } })
    fireEvent.submit(field.closest('form')!)
    expect(sent).toEqual(['echo "xin chào"', '\r'])
    expect(localStorage.getItem(TERMINAL_COMMAND_FIELD_KEY)).toBe('on')
  })

  it('with the keyboard down, answers a prompt: ↓ then Enter', async () => {
    device('phone')
    await openTerminal()
    expect(screen.queryByRole('button', { name: 'Ctrl' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Arrow down' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    expect(sent).toEqual(['\x1b[B', '\r'])
    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }))
    expect(term.focus).toHaveBeenCalled()
  })

  it('More sends Shift+Tab, and its Alt applies to the next key', async () => {
    device('phone')
    await openTerminal()
    fireEvent.click(screen.getByRole('button', { name: 'More keys' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Shift+Tab' }))
    expect(sent).toEqual(['\x1b[Z'])
    fireEvent.click(screen.getByRole('button', { name: 'More keys' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Alt' }))
    act(() => { typed?.('b') })
    expect(sent).toEqual(['\x1b[Z', '\x1bb'])
  })
})

describe('phone: touch gestures on the terminal', () => {
  it('a drag scrolls the scrollback: down shows older output', async () => {
    device('phone')
    await openTerminal()
    touch('pointerDown', 50, 100)
    touch('pointerMove', 50, 112)
    touch('pointerMove', 50, 200)
    // 88px at 13px text (15.6px rows): five lines back.
    expect(term.scrollLines.mock.calls[0]).toEqual([-5])
    touch('pointerUp', 50, 200)
    expect(sent).toEqual([])
  })

  it('in a full-screen program a drag is wheel events, which xterm turns into arrows', async () => {
    device('phone')
    await openTerminal()
    term.buffer.active.type = 'alternate'
    const wheels: number[] = []
    term.element!.addEventListener('wheel', (event) => wheels.push((event as WheelEvent).deltaY))
    touch('pointerDown', 50, 200)
    touch('pointerMove', 50, 188)
    touch('pointerMove', 50, 150)
    touch('pointerUp', 50, 150)
    expect(wheels.slice(0, 2)).toEqual([1, 1])
    expect(term.scrollLines).not.toHaveBeenCalled()
  })

  it('hold, then drag down: arrow-down keys, and no menu', async () => {
    device('phone')
    await openTerminal()
    touch('pointerDown', 50, 50)
    await wait(600)
    touch('pointerMove', 50, 90)
    await wait(20)
    touch('pointerUp', 50, 90)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((data) => data === '\x1b[B')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull()
  })

  it('a double tap sends Tab; taps far apart do not', async () => {
    device('phone')
    await openTerminal()
    touch('pointerDown', 40, 40)
    touch('pointerUp', 40, 40)
    touch('pointerDown', 200, 200)
    touch('pointerUp', 200, 200)
    expect(sent).toEqual([])
    touch('pointerDown', 202, 201)
    touch('pointerUp', 202, 201)
    expect(sent).toEqual(['\t'])
  })

  it('a pinch sets the text size, kept on the device, and More resets it', async () => {
    device('phone')
    await openTerminal()
    touch('pointerDown', 100, 100, 1)
    touch('pointerDown', 200, 100, 2)
    touch('pointerMove', 230, 100, 2)
    // 13px × 130/100 = 17px.
    expect(term.options.fontSize).toBe(17)
    touch('pointerUp', 230, 100, 2)
    touch('pointerUp', 100, 100, 1)
    expect(useDisplayPrefsStore.getState().terminalFontPx).toBe(17)
    expect(sent).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'More keys' }))
    expect(await screen.findByText('17 px')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(useDisplayPrefsStore.getState().terminalFontPx).toBeNull()
    await waitFor(() => expect(term.options.fontSize).toBe(13))
  })
})

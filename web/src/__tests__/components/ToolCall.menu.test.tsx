/**
 * A tool row's action menu, the same one a message or a code block has:
 * right-click and Shift+F10 open a floating menu, a touch long press opens the
 * items as a bottom sheet. The menu copies what the details show, lists only
 * what exists, and offers a result only once the tool has finished.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { useFakeTimers } from '../fake-timers'

// A plain browser, so the page menu draws (the desktop app hands it to the OS).
const platform = { isTauri: false, os: 'macos', isMacOverlay: false }
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => platform,
  getPlatform: () => platform,
}))

const haptics: string[] = []
mock.module('@/lib/haptics', () => ({
  softHapticFeedback: () => haptics.push('soft'),
  mediumHapticFeedback: () => haptics.push('medium'),
  selectionHapticFeedback: () => haptics.push('selection'),
  outcomeHapticFeedback: () => haptics.push('outcome'),
  haptic: () => haptics.push('haptic'),
}))

const { ToolCall } = await import('@/components/ToolCall')
const { LONG_PRESS_MS } = await import('@/hooks/use-long-press')
// The sheet loads on first use; have it cached so a test only waits a tick.
await import('@/components/ChatMenuSheet')

const realMatchMedia = window.matchMedia
function setCoarse(coarse: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const writeText = mock(async (..._args: unknown[]) => {})
let timers: ReturnType<typeof useFakeTimers>
beforeEach(() => {
  haptics.length = 0
  writeText.mockClear()
  setCoarse(false)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
  timers = useFakeTimers()
})
afterEach(() => {
  cleanup()
  timers.restore()
  window.matchMedia = realMatchMedia
  window.getSelection()?.removeAllRanges()
})

const ARGS = JSON.stringify({ path: 'src/main.py', offset: 10 })
const PRETTY_ARGS = JSON.stringify({ path: 'src/main.py', offset: 10 }, null, 2)
const row = (name = 'custom_tool') => screen.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${name} details$`) })
const menuItems = () => screen.queryAllByRole('menuitem').map((item) => item.textContent)
const surfaceOf = (button: HTMLElement) => button.querySelector('[data-slot="tool-row-surface"]') as HTMLElement
const escape = async () => {
  await act(async () => {
    screen.getByRole('menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

const touch = (extra: Record<string, unknown> = {}) => ({ pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 40, ...extra })
// Hold, then let the lazily loaded sheet mount (setImmediate is not faked).
const hold = async () => {
  await act(async () => { timers.tick(LONG_PRESS_MS + 60) })
  await act(async () => { await new Promise((resolve) => setImmediate(resolve)) })
}
const tap = (target: HTMLElement) => {
  fireEvent.pointerDown(target, touch())
  fireEvent.pointerUp(target, touch())
  fireEvent.click(target)
}

describe('right-click on a tool row', () => {
  it('opens Copy arguments and Copy result, named for the tool', async () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    expect(fireEvent.contextMenu(button)).toBe(false) // handled: no native menu
    expect(screen.getByRole('menu', { name: 'Actions for custom_tool' })).toBeTruthy()
    expect(menuItems()).toEqual(['Copy arguments', 'Copy result'])

    await act(async () => { screen.getByRole('menuitem', { name: 'Copy result' }).click() })
    expect(writeText).toHaveBeenCalledWith('some result')
    expect(screen.queryByRole('menu')).toBeNull()
    // Choosing an item is not a click on the row: it stays closed.
    expect(button.getAttribute('aria-expanded')).toBe('false')

    fireEvent.contextMenu(button)
    await act(async () => { screen.getByRole('menuitem', { name: 'Copy arguments' }).click() })
    // The arguments as the details show them.
    expect(writeText).toHaveBeenLastCalledWith(PRETTY_ARGS)
  })

  it('copies a shell command as its arguments, and the whole result', async () => {
    const result = '[Succeeded]\n\nhello'
    render(<ToolCall name="shell" args={JSON.stringify({ command: 'echo hello' })} done result={result} />)
    fireEvent.contextMenu(row('shell'))
    expect(screen.getByRole('menu', { name: 'Actions for shell' })).toBeTruthy()
    await act(async () => { screen.getByRole('menuitem', { name: 'Copy arguments' }).click() })
    expect(writeText).toHaveBeenLastCalledWith('echo hello')

    fireEvent.contextMenu(row('shell'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Copy result' }).click() })
    expect(writeText).toHaveBeenLastCalledWith(result)
  })

  it('offers no result while the tool still runs', () => {
    render(<ToolCall name="custom_tool" args={ARGS} result="partial" />)
    fireEvent.contextMenu(row())
    expect(menuItems()).toEqual(['Copy arguments'])
  })

  it('offers the result alone when the call took no arguments', () => {
    render(<ToolCall name="custom_tool" args="{}" done result="some result" />)
    fireEvent.contextMenu(row())
    expect(menuItems()).toEqual(['Copy result'])
  })

  it('copies what the details show: a tool that hides its arguments or its result has none to copy', () => {
    // A search hides its query (the row's target says it).
    const search = render(<ToolCall name="web_search" args={JSON.stringify({ query: 'typescript generics' })} done result="1. Generics" />)
    fireEvent.contextMenu(row('web_search'))
    expect(menuItems()).toEqual(['Copy result'])
    search.unmount()

    // An image's result is the markdown the reply already carries.
    render(<ToolCall name="generate_image" args={JSON.stringify({ prompt: 'a red fox', filename: 'fox' })} done result="![fox](fox.png)" />)
    fireEvent.contextMenu(row('generate_image'))
    expect(menuItems()).toEqual(['Copy arguments'])
  })

  it('picks up the result when the tool finishes', async () => {
    const { rerender } = render(<ToolCall name="custom_tool" args={ARGS} />)
    fireEvent.contextMenu(row())
    expect(menuItems()).toEqual(['Copy arguments'])
    await escape()

    rerender(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    fireEvent.contextMenu(row())
    expect(menuItems()).toEqual(['Copy arguments', 'Copy result'])
  })

  it('opens nothing for a row with nothing to copy', () => {
    render(<ToolCall name="custom_tool" />)
    const plain = screen.getByLabelText('custom_tool (no details)')
    expect(plain.tagName).toBe('DIV')
    // Nothing to offer: the browser's own menu stays.
    expect(fireEvent.contextMenu(plain)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens from the keyboard with Shift+F10 and the ContextMenu key', async () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    act(() => button.focus())
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(screen.getByRole('menu', { name: 'Actions for custom_tool' })).toBeTruthy()
    expect(menuItems()).toEqual(['Copy arguments', 'Copy result'])
    await escape()
    expect(screen.queryByRole('menu')).toBeNull()

    act(() => button.focus())
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
    })
    expect(menuItems()).toEqual(['Copy arguments', 'Copy result'])
  })

  it('leaves selected text to the native menu, which has Copy', () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    const range = document.createRange()
    range.selectNodeContents(button)
    window.getSelection()!.addRange(range)
    expect(fireEvent.contextMenu(button)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps its name and its toggle: the touch layer is hidden and passes a click on', () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    const surface = surfaceOf(button)
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    expect(surface.className).toContain('absolute')
    expect(surface.className).toContain('inset-0')
    expect(button.className).toContain('relative')
    expect(button.getAttribute('aria-label')).toBe('Expand custom_tool details')
    fireEvent.click(surface)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('long press on a tool row (touch)', () => {
  it('opens the items as a bottom sheet with a light haptic, and the hold does not toggle the row', async () => {
    setCoarse(true)
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    const surface = surfaceOf(button)

    fireEvent.pointerDown(surface, touch())
    expect(screen.queryByRole('dialog')).toBeNull()
    await hold()
    const sheet = screen.getByRole('dialog', { name: 'Actions for custom_tool' })
    expect(sheet.getAttribute('data-bottom-sheet')).toBe('')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(haptics).toEqual(['soft'])
    expect(Array.from(sheet.querySelectorAll('button')).map((item) => item.textContent)).toEqual(['Copy arguments', 'Copy result'])

    // The finger lifts: some touch browsers send a click after a hold.
    fireEvent.pointerUp(surface, touch())
    fireEvent.click(surface)
    expect(button.getAttribute('aria-expanded')).toBe('false')

    // Choosing an item copies and closes; it is not swallowed as the hold's click.
    await act(async () => { screen.getByRole('button', { name: 'Copy result' }).click() })
    expect(writeText).toHaveBeenCalledWith('some result')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not swallow a sheet item when the browser sent no click after the hold', async () => {
    setCoarse(true)
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const surface = surfaceOf(row())
    fireEvent.pointerDown(surface, touch())
    await hold()
    fireEvent.pointerUp(surface, touch())
    // No click on the row at all: the first click is the user's choice in the sheet.
    await act(async () => { screen.getByRole('button', { name: 'Copy arguments' }).click() })
    expect(writeText).toHaveBeenCalledWith(PRETTY_ARGS)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still toggles on a tap, also after an earlier hold', async () => {
    setCoarse(true)
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    const surface = surfaceOf(button)

    tap(surface)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()

    // Hold (opens the sheet, swallows its click), then plain taps work again.
    fireEvent.pointerDown(surface, touch())
    await hold()
    expect(screen.getByRole('dialog', { name: 'Actions for custom_tool' })).toBeTruthy()
    fireEvent.pointerUp(surface, touch())
    fireEvent.click(surface)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    tap(surface)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens nothing for a drag past the tolerance, a cancelled press or a mouse press', async () => {
    setCoarse(true)
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    const surface = surfaceOf(button)

    fireEvent.pointerDown(surface, touch())
    fireEvent.pointerMove(surface, touch({ clientY: 40 + 11 }))
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()
    // A press that wandered off is not a hold: the click after it is a click.
    fireEvent.pointerUp(surface, touch())
    fireEvent.click(surface)
    expect(button.getAttribute('aria-expanded')).toBe('true')

    fireEvent.pointerDown(surface, touch())
    fireEvent.pointerCancel(surface, touch())
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.pointerDown(surface, touch({ pointerType: 'mouse' }))
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(haptics).toEqual([])
  })

  it('takes the context-menu event a touch long press can raise (Android) as the sheet', async () => {
    setCoarse(true)
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    expect(fireEvent.contextMenu(row())).toBe(false)
    await act(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    expect(screen.getByRole('dialog', { name: 'Actions for custom_tool' })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the long press working when the row gains details (div → button)', async () => {
    setCoarse(true)
    const { rerender } = render(<ToolCall name="custom_tool" />)
    expect(screen.getByLabelText('custom_tool (no details)').tagName).toBe('DIV')

    rerender(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const button = row()
    expect(button.tagName).toBe('BUTTON')
    fireEvent.pointerDown(surfaceOf(button), touch())
    await hold()
    const sheet = screen.getByRole('dialog', { name: 'Actions for custom_tool' })
    expect(Array.from(sheet.querySelectorAll('button')).map((item) => item.textContent)).toEqual(['Copy arguments', 'Copy result'])
  })
})

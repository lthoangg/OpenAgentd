/**
 * A tool row's action menu, the same one a link has: right-click and
 * Shift+F10 open a floating menu, a touch long press opens the items as a
 * bottom sheet. It opens files, nothing else: a patch lists each file it
 * left in place, a read the file it read, at the line it started from. Any
 * other row keeps the system's menu. (Copy lives in the open row's details.)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReactElement } from 'react'
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
const { FileRefContext } = await import('@/components/FileRefLink')
type FileRef = { path: string; line?: number }
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

// The open workspace's opener: files under /repo (or relative) open.
const opened: FileRef[] = []
const opener = {
  workspace: '/repo',
  canOpen: (ref: FileRef) => !ref.path.startsWith('/') || ref.path.startsWith('/repo/'),
  open: (ref: FileRef) => { opened.push(ref) },
}
function renderInWorkspace(ui: ReactElement) {
  const view = render(<FileRefContext.Provider value={opener}>{ui}</FileRefContext.Provider>)
  return { ...view, rerender: (next: ReactElement) => view.rerender(<FileRefContext.Provider value={opener}>{next}</FileRefContext.Provider>) }
}
beforeEach(() => { opened.length = 0 })

const READ = JSON.stringify({ path: 'src/main.py', offset: 10 })
// History's short patch: files with kinds, no envelope.
const SHORT_PATCH = JSON.stringify({
  files: [
    { path: 'web/src/a.tsx', kind: 'update', additions: 2, deletions: 1 },
    { path: 'web/src/b.ts', kind: 'add', additions: 5, deletions: 0 },
    { path: 'old.css', kind: 'delete', additions: 0, deletions: 9 },
    { path: 'src/old-name.ts', kind: 'update', additions: 0, deletions: 0, move_to: 'src/new-name.ts' },
    { path: '/elsewhere/x.ts', kind: 'update', additions: 1, deletions: 0 },
  ],
})
const row = (name = 'read') => screen.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${name} details$`) })
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

describe('right-click on a patch row', () => {
  it('opens each file the patch left in place: not a deleted one, a moved one at its new path, none outside the workspace', async () => {
    renderInWorkspace(<ToolCall name="patch" args={SHORT_PATCH} done result="Patch applied successfully." />)
    const button = row('patch')
    expect(fireEvent.contextMenu(button)).toBe(false) // handled: no native menu
    expect(screen.getByRole('menu', { name: 'Actions for patch' })).toBeTruthy()
    expect(menuItems()).toEqual(['Open web/src/a.tsx', 'Open web/src/b.ts', 'Open src/new-name.ts'])

    await act(async () => { screen.getByRole('menuitem', { name: 'Open web/src/b.ts' }).click() })
    expect(opened).toEqual([{ path: 'web/src/b.ts' }])
    expect(screen.queryByRole('menu')).toBeNull()
    // Choosing an item is not a click on the row: it stays closed.
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('reads the files from a whole envelope too', () => {
    const patch_text = '*** Begin Patch\n*** Add File: notes/todo.md\n+hi\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Delete File: src/gone.ts\n*** End Patch'
    renderInWorkspace(<ToolCall name="patch" args={JSON.stringify({ patch_text })} done result="Patch applied successfully." />)
    fireEvent.contextMenu(row('patch'))
    expect(menuItems()).toEqual(['Open notes/todo.md', 'Open src/app.ts'])
  })

  it('after a failed patch, offers only the files that were there before it', () => {
    renderInWorkspace(<ToolCall name="patch" args={SHORT_PATCH} done result="Error: context did not match" />)
    fireEvent.contextMenu(row('patch'))
    expect(menuItems()).toEqual(['Open web/src/a.tsx', 'Open src/old-name.ts'])
  })

  it('while the patch runs, offers only the files that are already there', () => {
    const patch_text = '*** Begin Patch\n*** Add File: notes/todo.md\n+hi\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-a\n+b\n*** End Patch'
    renderInWorkspace(<ToolCall name="patch" args={JSON.stringify({ patch_text })} done={false} />)
    fireEvent.contextMenu(row('patch'))
    expect(menuItems()).toEqual(['Open src/app.ts', 'Open src/old.ts'])
  })
})

describe('right-click on a read row', () => {
  it('opens the file at the line the read started from', async () => {
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
    fireEvent.contextMenu(row())
    expect(menuItems()).toEqual(['Open src/main.py'])
    await act(async () => { screen.getByRole('menuitem', { name: 'Open src/main.py' }).click() })
    expect(opened).toEqual([{ path: 'src/main.py', line: 10 }])
  })

  it('opens a read from the top at the top, and names a workspace path relative to it', async () => {
    renderInWorkspace(<ToolCall name="read" args={JSON.stringify({ path: '/repo/src/app.ts', offset: '1' })} done result="1: x" />)
    fireEvent.contextMenu(row())
    expect(menuItems()).toEqual(['Open src/app.ts'])
    await act(async () => { screen.getByRole('menuitem', { name: 'Open src/app.ts' }).click() })
    expect(opened).toEqual([{ path: '/repo/src/app.ts' }])
  })

  it('takes a numeric string offset, as the tool does', async () => {
    renderInWorkspace(<ToolCall name="read" args={JSON.stringify({ path: 'src/main.py', offset: '42' })} done result="42: x" />)
    fireEvent.contextMenu(row())
    await act(async () => { screen.getByRole('menuitem', { name: 'Open src/main.py' }).click() })
    expect(opened).toEqual([{ path: 'src/main.py', line: 42 }])
  })
})

describe('rows with no file to open', () => {
  it('leave right-click to the system: shell, other tools, no workspace, a file outside it', () => {
    const cases: Array<[string, string, boolean]> = [
      ['shell', JSON.stringify({ command: 'echo hello' }), true],
      ['custom_tool', JSON.stringify({ path: 'src/main.py' }), true],
      ['read', JSON.stringify({ path: '/elsewhere/x.ts' }), true],
      ['read', READ, false],
    ]
    for (const [name, args, inWorkspace] of cases) {
      const ui = <ToolCall name={name} args={args} done result="[Succeeded]\nok" />
      const view = inWorkspace ? renderInWorkspace(ui) : render(ui)
      expect({ name, args, handled: !fireEvent.contextMenu(row(name)) }).toEqual({ name, args, handled: false })
      expect(screen.queryByRole('menu')).toBeNull()
      view.unmount()
    }
  })

  it('opens nothing for a row with no details yet', () => {
    renderInWorkspace(<ToolCall name="custom_tool" />)
    const plain = screen.getByLabelText('custom_tool (no details)')
    expect(plain.tagName).toBe('DIV')
    expect(fireEvent.contextMenu(plain)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('the menu itself', () => {
  it('opens from the keyboard with Shift+F10 and the ContextMenu key', async () => {
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
    const button = row()
    act(() => button.focus())
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(screen.getByRole('menu', { name: 'Actions for read' })).toBeTruthy()
    expect(menuItems()).toEqual(['Open src/main.py'])
    await escape()
    expect(screen.queryByRole('menu')).toBeNull()

    act(() => button.focus())
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
    })
    expect(menuItems()).toEqual(['Open src/main.py'])
  })

  it('leaves selected text to the native menu, which has Copy', () => {
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
    const button = row()
    const range = document.createRange()
    range.selectNodeContents(button)
    window.getSelection()!.addRange(range)
    expect(fireEvent.contextMenu(button)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps its name and its toggle: the touch layer is hidden and passes a click on', () => {
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
    const button = row()
    const surface = surfaceOf(button)
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    expect(surface.className).toContain('absolute')
    expect(surface.className).toContain('inset-0')
    expect(button.className).toContain('relative')
    expect(button.getAttribute('aria-label')).toBe('Expand read details')
    fireEvent.click(surface)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('long press on a tool row (touch)', () => {
  it('opens the items as a bottom sheet with a medium haptic, and the hold does not toggle the row', async () => {
    setCoarse(true)
    renderInWorkspace(<ToolCall name="patch" args={SHORT_PATCH} done result="Patch applied successfully." />)
    const button = row('patch')
    const surface = surfaceOf(button)

    fireEvent.pointerDown(surface, touch())
    expect(screen.queryByRole('dialog')).toBeNull()
    await hold()
    const sheet = screen.getByRole('dialog', { name: 'Actions for patch' })
    expect(sheet.getAttribute('data-bottom-sheet')).toBe('')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(haptics).toEqual(['medium'])
    expect(Array.from(sheet.querySelectorAll('button')).map((item) => item.textContent)).toEqual(['Open web/src/a.tsx', 'Open web/src/b.ts', 'Open src/new-name.ts', 'Cancel'])

    // The finger lifts: some touch browsers send a click after a hold.
    fireEvent.pointerUp(surface, touch())
    fireEvent.click(surface)
    expect(button.getAttribute('aria-expanded')).toBe('false')

    // Choosing an item opens the file and closes; it is not swallowed as the hold's click.
    await act(async () => { screen.getByRole('button', { name: 'Open web/src/a.tsx' }).click() })
    expect(opened).toEqual([{ path: 'web/src/a.tsx' }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not swallow a sheet item when the browser sent no click after the hold', async () => {
    setCoarse(true)
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
    const surface = surfaceOf(row())
    fireEvent.pointerDown(surface, touch())
    await hold()
    fireEvent.pointerUp(surface, touch())
    // No click on the row at all: the first click is the user's choice in the sheet.
    await act(async () => { screen.getByRole('button', { name: 'Open src/main.py' }).click() })
    expect(opened).toEqual([{ path: 'src/main.py', line: 10 }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still toggles on a tap, also after an earlier hold', async () => {
    setCoarse(true)
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
    const button = row()
    const surface = surfaceOf(button)

    tap(surface)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()

    // Hold (opens the sheet, swallows its click), then plain taps work again.
    fireEvent.pointerDown(surface, touch())
    await hold()
    expect(screen.getByRole('dialog', { name: 'Actions for read' })).toBeTruthy()
    fireEvent.pointerUp(surface, touch())
    fireEvent.click(surface)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    tap(surface)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens nothing for a drag past the tolerance, a cancelled press or a mouse press', async () => {
    setCoarse(true)
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
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
    renderInWorkspace(<ToolCall name="read" args={READ} done result="10: x" />)
    expect(fireEvent.contextMenu(row())).toBe(false)
    await act(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    expect(screen.getByRole('dialog', { name: 'Actions for read' })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the long press working when the row gains details (div → button)', async () => {
    setCoarse(true)
    const { rerender } = renderInWorkspace(<ToolCall name="patch" />)
    expect(screen.getByLabelText('patch (no details)').tagName).toBe('DIV')

    rerender(<ToolCall name="patch" args={SHORT_PATCH} done result="Patch applied successfully." />)
    const button = row('patch')
    expect(button.tagName).toBe('BUTTON')
    fireEvent.pointerDown(surfaceOf(button), touch())
    await hold()
    const sheet = screen.getByRole('dialog', { name: 'Actions for patch' })
    expect(Array.from(sheet.querySelectorAll('button')).map((item) => item.textContent)).toEqual(['Open web/src/a.tsx', 'Open web/src/b.ts', 'Open src/new-name.ts', 'Cancel'])
  })
})

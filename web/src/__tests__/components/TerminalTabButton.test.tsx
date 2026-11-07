/**
 * TerminalTabButton — tab chip for terminal sessions in WorkspacePanel.
 *
 * Desktop: right-click opens a small menu (Rename / Close).
 * Mobile: long-press opens the same choice as an action sheet.
 * Both funnel into useTerminalStore.rename() / .close().
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getTerminalRuntime, useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'

const Icon = () => null
const Spinner = () => <span data-icon="spinner" />
mock.module('lucide-react', () => ({ MoreHorizontal: Icon, SlidersHorizontal: Icon, TerminalSquare: Icon, X: Icon, Pencil: Icon, Eraser: Icon, Loader2: Spinner }))
mock.module('@/api/terminal', () => ({ connectTerminal: mock(() => new Promise(() => {})) }))

beforeEach(() => {
  _resetTerminalStoreForTests()
})
afterEach(cleanup)

async function setup(mobile = false, os: 'macos' | 'linux' = 'linux') {
  const { TerminalTabButton } = await import('@/components/Terminal/TerminalTabButton')
  const id = useTerminalStore.getState().open({ workspace: '/tmp/ws' }, '/tmp/ws')
  const onActivate = mock(() => {})
  render(
    <TerminalTabButton
      meta={useTerminalStore.getState().sessions[id]}
      active
      mobile={mobile}
      os={os}
      onActivate={onActivate}
    />,
  )
  return { id, onActivate }
}

describe('TerminalTabButton', () => {
  it('clicking the tab activates it', async () => {
    const { onActivate } = await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal 1' }))
    expect(onActivate).toHaveBeenCalled()
  })

  it('marks a desktop tab whose shell is running a command with the spinner and the word', async () => {
    const { TerminalTabButton } = await import('@/components/Terminal/TerminalTabButton')
    const id = useTerminalStore.getState().open({ workspace: '/tmp/ws' }, '/tmp/ws')
    const meta = useTerminalStore.getState().sessions[id]
    const tab = (busy: boolean, mobile: boolean) => (
      <TerminalTabButton meta={{ ...meta, busy }} active mobile={mobile} os="linux" onActivate={() => {}} />
    )
    const { rerender } = render(tab(false, false))
    const button = screen.getByRole('button', { name: 'Terminal 1' })
    expect(button.querySelector('[data-icon="spinner"]')).toBeNull()
    expect(button.getAttribute('aria-description')).toBeNull()

    rerender(tab(true, false))
    expect(button.querySelector('[data-icon="spinner"]')).not.toBeNull()
    expect(button.getAttribute('aria-description')).toBe('Running')
    // The name stays the terminal's.
    expect(screen.getByRole('button', { name: 'Terminal 1' })).toBe(button)

    // The phone's tab is unchanged.
    cleanup()
    render(tab(true, true))
    expect(screen.getByRole('button', { name: 'Terminal 1' }).querySelector('[data-icon="spinner"]')).toBeNull()
  })

  it('the inline close button closes the session immediately (no confirmation)', async () => {
    const { id } = await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }))
    expect(useTerminalStore.getState().sessions[id]).toBeUndefined()
  })

  it('keeps the × on touch too, at 36px, so a phone can close a terminal without a long press', async () => {
    const { id } = await setup(true)
    const close = screen.getByRole('button', { name: 'Close Terminal 1' })
    expect(close.className).toContain('pointer-coarse:size-9')
    fireEvent.click(close)
    expect(useTerminalStore.getState().sessions[id]).toBeUndefined()
  })

  it('desktop right-click opens a menu with Rename and Close', async () => {
    await setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    expect(await screen.findByRole('menuitem', { name: /Rename/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Close/ })).toBeTruthy()
  })

  it('the menu spells the key of each row that has one: F2 renames, ⌘W closes', async () => {
    await setup(false, 'macos')
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Terminal 1' })
    const keyOf = (name: string) => Array.from(menu.querySelectorAll('[role="menuitem"]'))
      .find((item) => (item.querySelector('span.flex-1')?.textContent ?? item.textContent) === name)?.querySelector('kbd')?.textContent
    expect(keyOf('Rename')).toBe('F2')
    expect(keyOf('Close')).toBe('⌘W')
    expect(keyOf('Clear')).toBeUndefined()
  })

  it('spells Close for Windows and Linux too', async () => {
    await setup(false, 'linux')
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Terminal 1' })
    const close = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((item) => item.querySelector('span.flex-1')?.textContent === 'Close')
    expect(close?.querySelector('kbd')?.textContent).toBe('Ctrl+W')
  })

  it('closes with the shared CloseButton: named for the terminal, one glyph size with the other tabs', async () => {
    await setup()
    const close = screen.getByRole('button', { name: 'Close Terminal 1' })
    expect(close.hasAttribute('data-close-button')).toBe(true)
    expect(close.hasAttribute('data-dock-tab-close')).toBe(true)
    expect(close.className).toContain('size-6')
  })

  it('Clear in the desktop menu clears the scrollback (⌘K now opens the palette)', async () => {
    const { id } = await setup()
    const clear = mock(() => {})
    // The xterm handle arrives asynchronously (setup.ts mocks it).
    await waitFor(() => expect(useTerminalStore.getState().sessions[id]?.handleReady).toBe(true))
    Object.assign(getTerminalRuntime(id)?.handle?.term ?? {}, { clear })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Clear/ }))
    expect(clear).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Rename in the desktop menu edits the title in place, without a dialog', async () => {
    const { id } = await setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }))

    const input = await screen.findByLabelText('Terminal name')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('button', { name: 'Terminal 1' })).toBeNull()
    fireEvent.change(input, { target: { value: 'Build watcher' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useTerminalStore.getState().sessions[id]?.title).toBe('Build watcher')
    expect(screen.queryByLabelText('Terminal name')).toBeNull()
    // The harness passes ``meta`` once, so the tab button comes back with
    // the old label; the dock re-renders it from the store.
    expect(screen.getByRole('button', { name: 'Terminal 1' })).toBeTruthy()
  })

  it('F2 or a double-click on the tab starts renaming; Escape keeps the old title', async () => {
    const { id } = await setup()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Terminal 1' }), { key: 'F2' })
    let input = await screen.findByLabelText('Terminal name')
    fireEvent.change(input, { target: { value: 'Nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useTerminalStore.getState().sessions[id]?.title).toBe('Terminal 1')
    expect(screen.queryByLabelText('Terminal name')).toBeNull()

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Terminal 1' }))
    input = await screen.findByLabelText('Terminal name')
    fireEvent.change(input, { target: { value: 'Server' } })
    fireEvent.blur(input)
    expect(useTerminalStore.getState().sessions[id]?.title).toBe('Server')
  })

  it('closing via the desktop menu closes the session', async () => {
    const { id } = await setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Close/ }))
    expect(useTerminalStore.getState().sessions[id]).toBeUndefined()
  })

  it('mobile long-press opens an action sheet with Rename and Close (no native context menu)', async () => {
    await setup(true)
    const button = screen.getByRole('button', { name: 'Terminal 1' })
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy(), {
      timeout: 1500,
    })
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeTruthy()
  })

  it('renaming via the mobile sheet updates the store title', async () => {
    const { id } = await setup(true)
    const button = screen.getByRole('button', { name: 'Terminal 1' })
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 })
    // The sheet opens after the long-press delay: wait as the test above does,
    // or a loaded full-suite run times out while the tab is still pressing.
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }, { timeout: 1500 }))

    const input = await screen.findByLabelText('Terminal name')
    fireEvent.change(input, { target: { value: 'Logs' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(useTerminalStore.getState().sessions[id]?.title).toBe('Logs'))
  })
})

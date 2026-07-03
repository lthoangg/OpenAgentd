/**
 * TerminalTabButton — shared tab chip for terminal sessions (used by both
 * CodingWorkspacePanel and the cockpit TerminalPanel).
 *
 * Desktop: right-click opens a small menu (Rename / Close).
 * Mobile: long-press opens the same choice as an action sheet.
 * Both funnel into useTerminalStore.rename() / .close().
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'

const Icon = () => null
mock.module('lucide-react', () => ({ TerminalSquare: Icon, X: Icon, Pencil: Icon }))
mock.module('@/api/terminal', () => ({ connectTerminal: mock(() => new Promise(() => {})) }))

beforeEach(() => {
  _resetTerminalStoreForTests()
})
afterEach(cleanup)

async function setup(mobile = false) {
  const { TerminalTabButton } = await import('@/components/Terminal/TerminalTabButton')
  const id = useTerminalStore.getState().open({ workspace: '/tmp/ws' }, '/tmp/ws')
  const onActivate = mock(() => {})
  render(
    <TerminalTabButton
      meta={useTerminalStore.getState().sessions[id]}
      active
      mobile={mobile}
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

  it('the inline close button closes the session immediately (no confirmation)', async () => {
    const { id } = await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }))
    expect(useTerminalStore.getState().sessions[id]).toBeUndefined()
  })

  it('desktop right-click opens a menu with Rename and Close', async () => {
    await setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    expect(await screen.findByRole('menuitem', { name: /Rename/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Close/ })).toBeTruthy()
  })

  it('renaming via the desktop menu updates the store title', async () => {
    const { id } = await setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Terminal 1' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }))

    const input = await screen.findByLabelText('Terminal name')
    fireEvent.change(input, { target: { value: 'Build watcher' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() =>
      expect(useTerminalStore.getState().sessions[id]?.title).toBe('Build watcher'),
    )
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
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))

    const input = await screen.findByLabelText('Terminal name')
    fireEvent.change(input, { target: { value: 'Logs' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(useTerminalStore.getState().sessions[id]?.title).toBe('Logs'))
  })
})

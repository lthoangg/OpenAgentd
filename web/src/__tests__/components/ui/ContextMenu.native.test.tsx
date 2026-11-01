import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

let platform: { isTauri: boolean; os: string } = { isTauri: true, os: 'macos' }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform, usePlatform: () => platform }))

let chosen: () => Promise<unknown> = async () => null
const invoke = mock(async (..._args: unknown[]) => chosen())
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { ContextMenu, ContextMenuSeparator, CONTEXT_MENU_ITEM_CLASS } = await import('@/components/ui/context-menu')

afterEach(() => {
  cleanup()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})
beforeEach(() => {
  platform = { isTauri: true, os: 'macos' }
  // The desktop app's IPC bridge, which the native menu goes through.
  ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  chosen = async () => null
  invoke.mockClear()
})

function renderMenu(handlers: { rename?: () => void; pin?: () => void; onDismiss?: () => void } = {}) {
  return render(
    <ContextMenu at={{ x: 40, y: 60 }} label="Actions for Draft" onDismiss={handlers.onDismiss ?? (() => {})}>
      <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM_CLASS} onClick={handlers.rename}>
        Rename<kbd aria-hidden="true">F2</kbd>
      </button>
      <ContextMenuSeparator />
      <button type="button" role="menuitemcheckbox" aria-checked="true" className={CONTEXT_MENU_ITEM_CLASS} onClick={handlers.pin}>
        Pinned
      </button>
      <button type="button" role="menuitem" disabled className={CONTEXT_MENU_ITEM_CLASS}>
        Delete session…
      </button>
    </ContextMenu>,
  )
}

describe('ContextMenu in the desktop app', () => {
  it('shows the operating system menu with the same items, checks and disabled states', async () => {
    renderMenu()

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke.mock.calls[0]).toEqual([
      'show_context_menu',
      {
        items: [
          { id: '0', label: 'Rename', enabled: true },
          { separator: true },
          { id: '1', label: 'Pinned', enabled: true, checked: true },
          { id: '2', label: 'Delete session…', enabled: false },
        ],
        x: 40,
        y: 60,
      },
    ])
  })

  it('runs the chosen item and then closes', async () => {
    const pin = mock(() => {})
    const onDismiss = mock(() => {})
    chosen = async () => '1'

    renderMenu({ pin, onDismiss })

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
    expect(pin).toHaveBeenCalledTimes(1)
  })

  it('closes without running anything when the menu is dismissed', async () => {
    const rename = mock(() => {})
    const onDismiss = mock(() => {})

    renderMenu({ rename, onDismiss })

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
    expect(rename).not.toHaveBeenCalled()
  })

  it('keeps the page menu hidden while the native one is up', async () => {
    let release: (value: unknown) => void = () => {}
    chosen = () => new Promise((resolve) => { release = resolve })

    renderMenu()

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('menu')).toBeNull()
    release(null)
  })

  it('falls back to the page menu when the shell cannot show one', async () => {
    chosen = async () => {
      throw new Error('unknown command')
    }

    renderMenu()

    const menu = await screen.findByRole('menu', { name: 'Actions for Draft' })
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Rename'))
    expect(menu).toBeTruthy()
  })
})

describe('ContextMenu in a browser', () => {
  it('shows the page menu straight away and never asks the shell', () => {
    platform = { isTauri: false, os: 'macos' }
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

    renderMenu()

    expect(screen.getByRole('menu', { name: 'Actions for Draft' })).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })
})

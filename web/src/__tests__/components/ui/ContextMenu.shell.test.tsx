/**
 * The app draws its own menus in every shell. "Native" is the feel (where a
 * menu opens, how keys move through it), not the operating system's widget:
 * the desktop and iOS apps used to hand the items to the OS menu or an iOS
 * action sheet, which looked unlike every other menu in the app.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

let platform: { isTauri: boolean; os: string } = { isTauri: true, os: 'macos' }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform, usePlatform: () => platform }))

const invoke = mock(async (..._args: unknown[]) => null)
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { ContextMenu, ContextMenuSeparator, CONTEXT_MENU_ITEM_CLASS } = await import('@/components/ui/context-menu')

afterEach(() => {
  cleanup()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})
beforeEach(() => {
  invoke.mockClear()
})

function renderMenu(handlers: { pin?: () => void; onDismiss?: () => void } = {}) {
  return render(
    <ContextMenu at={{ x: 40, y: 60 }} label="Actions for Draft" onDismiss={handlers.onDismiss ?? (() => {})}>
      <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM_CLASS}>
        Rename<kbd aria-hidden="true">F2</kbd>
      </button>
      <ContextMenuSeparator />
      <button type="button" role="menuitemcheckbox" aria-checked="true" className={CONTEXT_MENU_ITEM_CLASS} onClick={handlers.pin}>
        Pinned
      </button>
    </ContextMenu>,
  )
}

describe('ContextMenu in every shell', () => {
  const shells: Array<[string, { isTauri: boolean; os: string }]> = [
    ['the macOS app', { isTauri: true, os: 'macos' }],
    ['the Windows app', { isTauri: true, os: 'windows' }],
    ['the Linux app', { isTauri: true, os: 'linux' }],
    ['the iPhone and iPad app', { isTauri: true, os: 'ios' }],
    ['a browser', { isTauri: false, os: 'macos' }],
  ]
  it.each(shells)('draws its own menu in %s and never asks the shell for one', async (_name, shell) => {
    platform = shell
    if (shell.isTauri) (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}

    renderMenu()

    const menu = screen.getByRole('menu', { name: 'Actions for Draft' })
    expect(menu.closest('[aria-hidden="true"]')).toBeNull()
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Rename'))
    // Give a native request every chance to be made.
    await act(async () => { await Promise.resolve() })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('runs a picked item in the desktop app and then closes', async () => {
    platform = { isTauri: true, os: 'macos' }
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const pin = mock(() => {})
    const onDismiss = mock(() => {})
    renderMenu({ pin, onDismiss })

    await act(async () => { screen.getByRole('menuitemcheckbox', { name: 'Pinned' }).click() })

    expect(pin).toHaveBeenCalledTimes(1)
  })
})

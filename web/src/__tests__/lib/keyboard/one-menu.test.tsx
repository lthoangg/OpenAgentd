/**
 * One menu at a time: whatever opens over the app (a menu, a popover, a
 * dialog, Settings) closes the menus and popovers already open, unless it
 * opened from inside one of them; an app shortcut closes them too, and so
 * does a click into a page's frame. Dialogs and overlays are never closed
 * this way.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { getPlatform } from '@/hooks/use-platform'
import { ContextMenu } from '@/components/ui/context-menu'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { _resetKeyboardForTests, installKeyboard, registerShortcut } from '@/lib/keyboard/dispatcher'
import { KeyLayerScope, useKeyLayer } from '@/lib/keyboard/hooks'
import { layerStack, pushLayer } from '@/lib/keyboard/layers'

const MOD = getPlatform().os === 'macos' ? { metaKey: true } : { ctrlKey: true }

afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
})

describe('the layer stack', () => {
  it('closes the open menus when anything else opens over the app', () => {
    const menu = mock(() => {})
    const dialog = mock(() => {})
    pushLayer({ kind: 'transient', close: menu })
    pushLayer({ kind: 'dialog', close: dialog })
    expect(menu).toHaveBeenCalledTimes(1)

    // A dialog or overlay stays: only menus and popovers give way.
    pushLayer({ kind: 'transient', close: () => {} })
    pushLayer({ kind: 'overlay', close: () => {} })
    expect(dialog).not.toHaveBeenCalled()
  })

  it('keeps the menu a new layer opened from, and the one opened from it', () => {
    const outer = {}
    const inner = {}
    const closeOuter = mock(() => {})
    const closeInner = mock(() => {})
    pushLayer({ kind: 'transient', close: closeOuter, scope: outer, within: [] })
    pushLayer({ kind: 'transient', close: closeInner, scope: inner, within: [outer] })
    pushLayer({ kind: 'dialog', close: () => {}, scope: {}, within: [outer, inner] })
    expect(closeOuter).not.toHaveBeenCalled()
    expect(closeInner).not.toHaveBeenCalled()
  })

  // React runs a child's effects before its parent's: a menu opened in the
  // same render as the popover around it pushes first.
  it('keeps a menu pushed before the layer it sits in', () => {
    const parent = {}
    const closeChild = mock(() => {})
    pushLayer({ kind: 'transient', close: closeChild, scope: {}, within: [parent] })
    pushLayer({ kind: 'transient', close: () => {}, scope: parent, within: [] })
    expect(closeChild).not.toHaveBeenCalled()
  })
})

describe('the dispatcher', () => {
  it('closes the open menus when an app shortcut runs', () => {
    const menu = mock(() => {})
    const shortcut = mock(() => {})
    registerShortcut({ key: 'D', mod: true }, shortcut)
    pushLayer({ kind: 'transient', close: menu })

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true, ...MOD }))
    expect(shortcut).toHaveBeenCalledTimes(1)
    expect(menu).toHaveBeenCalledTimes(1)
  })

  it('leaves them open for a key no shortcut takes', () => {
    const menu = mock(() => {})
    registerShortcut({ key: 'D', mod: true }, () => false)
    pushLayer({ kind: 'transient', close: menu })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true, ...MOD }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }))
    expect(menu).not.toHaveBeenCalled()
  })

  // A click in a preview page or an MCP app goes to its frame, so no click
  // reaches this document: the window's blur, with a frame focused, does.
  it('closes the open menus when focus goes into a frame', async () => {
    installKeyboard()
    const menu = mock(() => {})
    const dialog = mock(() => {})
    pushLayer({ kind: 'dialog', close: dialog })
    pushLayer({ kind: 'transient', close: menu })
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => frame })
    try {
      window.dispatchEvent(new Event('blur'))
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
      frame.remove()
    }
    expect(menu).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveBeenCalled()
  })
})

function TwoPopovers() {
  const [a, setA] = useState(true)
  const [b, setB] = useState(false)
  return (
    <>
      <Popover open={a} onOpenChange={setA}>
        <PopoverTrigger>A</PopoverTrigger>
        <PopoverContent aria-label="Popover A">a</PopoverContent>
      </Popover>
      <Popover open={b} onOpenChange={setB}>
        <PopoverTrigger>B</PopoverTrigger>
        <PopoverContent aria-label="Popover B">b</PopoverContent>
      </Popover>
      {/* Opened by something other than a click: a shortcut, a store. */}
      <button type="button" onKeyDown={() => setB(true)}>open B</button>
    </>
  )
}

function Panel({ open, onClose, children }: { open: boolean; onClose: () => void; children?: React.ReactNode }) {
  const layer = useKeyLayer(open, { kind: 'transient', onClose })
  return open ? <KeyLayerScope layer={layer}><div aria-label="Panel">{children}</div></KeyLayerScope> : null
}

describe('menus and popovers', () => {
  it('a popover opened without a click closes the one already open', async () => {
    render(<TwoPopovers />)
    expect(screen.getByLabelText('Popover A')).toBeTruthy()
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'open B' }), { key: 'x' }) })
    expect(screen.getByLabelText('Popover B')).toBeTruthy()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    expect(screen.queryByLabelText('Popover A')).toBeNull()
  })

  it('a context menu closes an open popover and is a layer itself', async () => {
    function Both() {
      const [menu, setMenu] = useState(false)
      const [popover, setPopover] = useState(true)
      return (
        <>
          <Popover open={popover} onOpenChange={setPopover}>
            <PopoverTrigger>P</PopoverTrigger>
            <PopoverContent aria-label="Popover">p</PopoverContent>
          </Popover>
          <button type="button" onKeyDown={() => setMenu(true)}>menu</button>
          {menu && (
            <ContextMenu at={{ x: 10, y: 10 }} label="Row actions" onDismiss={() => setMenu(false)}>
              <button type="button" role="menuitem">Rename</button>
            </ContextMenu>
          )}
        </>
      )
    }
    render(<Both />)
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'menu' }), { key: 'x' }) })
    expect(layerStack().filter((layer) => layer.kind === 'transient').length).toBeGreaterThanOrEqual(1)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    expect(screen.queryByLabelText('Popover')).toBeNull()
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeTruthy()
  })

  it('keeps a popover open while a dropdown inside it opens', async () => {
    function Nested() {
      const [open, setOpen] = useState(true)
      const [value, setValue] = useState('a')
      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger>P</PopoverTrigger>
          <PopoverContent aria-label="Popover">
            <Dropdown aria-label="Pick" value={value} onValueChange={setValue} trigger="Pick">
              <DropdownItem value="a">A</DropdownItem>
              <DropdownItem value="b">B</DropdownItem>
            </Dropdown>
          </PopoverContent>
        </Popover>
      )
    }
    render(<Nested />)
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'Pick' }), { key: 'ArrowDown' }) })
    expect(screen.getByRole('listbox')).toBeTruthy()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    expect(screen.getByLabelText('Popover')).toBeTruthy()
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('keeps a panel open while a context menu inside it opens', async () => {
    function Drawer() {
      const [open, setOpen] = useState(true)
      const [menu, setMenu] = useState(false)
      return (
        <Panel open={open} onClose={() => setOpen(false)}>
          <button type="button" onKeyDown={() => setMenu(true)}>row</button>
          {menu && (
            <ContextMenu at={{ x: 10, y: 10 }} label="Row actions" onDismiss={() => setMenu(false)}>
              <button type="button" role="menuitem">Rename</button>
            </ContextMenu>
          )}
        </Panel>
      )
    }
    render(<Drawer />)
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'row' }), { key: 'x' }) })
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeTruthy()
    expect(screen.getByLabelText('Panel')).toBeTruthy()
  })
})

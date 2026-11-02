/**
 * Menus and popovers draw above everything they open from: the dock, the
 * sidebar, a dialog, and the notices in the corner. A menu drawn inside the
 * component that opened it is caught by that component's stacking context
 * (a z-index, a transform, container queries) and can end up under its
 * neighbours, so every floating surface renders into ``document.body`` on
 * one layer above the notices (z-60) and below tooltips.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ContextMenu } from '@/components/ui/context-menu'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

afterEach(cleanup)

const MENU_LAYER = 'z-70'

describe('floating layers', () => {
  it('draws a context menu in document.body, outside the panel that opened it', () => {
    render(
      <div data-testid="panel" className="relative z-20 overflow-hidden" style={{ transform: 'translateX(0)' }}>
        <ContextMenu at={{ x: 10, y: 10 }} label="Tab actions" onDismiss={() => {}}>
          <button type="button" role="menuitem">Close</button>
        </ContextMenu>
      </div>,
    )
    const menu = screen.getByRole('menu', { name: 'Tab actions' })
    expect(screen.getByTestId('panel').contains(menu)).toBe(false)
    const backdrop = menu.parentElement as HTMLElement
    expect(backdrop.parentElement).toBe(document.body)
    expect(backdrop.className).toContain(MENU_LAYER)
  })

  it('still runs the opener\'s React handlers from inside the portal', () => {
    let clicked = 0
    render(
      <div onClick={() => { clicked += 1 }}>
        <ContextMenu at={{ x: 10, y: 10 }} label="Tab actions" onDismiss={() => {}}>
          <button type="button" role="menuitem">Close</button>
        </ContextMenu>
      </div>,
    )
    // The menu stops clicks inside it; the backdrop's dismissal bubbles as before.
    fireEvent.click(screen.getByRole('menu').parentElement as HTMLElement)
    expect(clicked).toBe(1)
  })

  it('puts dropdowns and popovers on the same layer, above the notices', () => {
    render(
      <>
        <Dropdown value="a" onValueChange={() => {}} trigger="Choose…" aria-label="Pick">
          <DropdownItem value="a">Alpha</DropdownItem>
          <DropdownItem value="b">Beta</DropdownItem>
        </Dropdown>
        <Popover open onOpenChange={() => {}}>
          <PopoverTrigger render={<button type="button">Open</button>} />
          <PopoverContent aria-label="Details">Body</PopoverContent>
        </Popover>
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Pick/ }))
    const listbox = screen.getByRole('listbox')
    const panel = listbox.closest('.fixed') as HTMLElement
    expect(panel.className).toContain(MENU_LAYER)
    const popover = screen.getByText('Body').closest('.fixed') as HTMLElement
    expect(popover.className).toContain(MENU_LAYER)
  })
})

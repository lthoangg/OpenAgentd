/**
 * Modals on the keyboard layer stack: Escape closes the top one only, app
 * shortcuts stay blocked behind them, and only overlays let switchers
 * (⌘K, ⌘P, ⌘,) through.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TodosPopover } from '@/components/TodosPopover'
import { useModalFocus } from '@/hooks/useModalFocus'
import { getPlatform } from '@/hooks/use-platform'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { useAppShortcut } from '@/lib/keyboard/hooks'

const MOD = getPlatform().os === 'macos' ? { metaKey: true } : { ctrlKey: true }

function press(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}

afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
})

function Overlay({ open, onClose, allowSwitch, label }: { open: boolean; onClose: () => void; allowSwitch?: () => boolean; label: string }) {
  useModalFocus(open, onClose, undefined, { kind: 'overlay', allowSwitch })
  if (!open) return null
  return (
    <div data-modal-focus="true" role="dialog" aria-label={label}>
      <button type="button">{label} first</button>
      <button type="button">{label} last</button>
    </div>
  )
}

function Shortcuts({ onNew, onPalette }: { onNew: () => void; onPalette: () => void }) {
  useAppShortcut('newSession', onNew)
  useAppShortcut('commandPalette', onPalette)
  return null
}

describe('modal layers', () => {
  it('closes a dialog opened over an overlay before the overlay', () => {
    const closeOverlay = mock(() => {})
    const closeDialog = mock(() => {})
    render(
      <>
        <Overlay open onClose={closeOverlay} label="Settings" />
        <Dialog open onOpenChange={(next) => { if (!next) closeDialog() }}>
          <DialogContent><DialogTitle>Delete?</DialogTitle></DialogContent>
        </Dialog>
      </>,
    )
    press({ key: 'Escape' })
    expect(closeDialog).toHaveBeenCalledTimes(1)
    expect(closeOverlay).not.toHaveBeenCalled()
  })

  it('blocks app shortcuts behind a dialog, switchers included', () => {
    const onNew = mock(() => {})
    const onPalette = mock(() => {})
    render(
      <>
        <Shortcuts onNew={onNew} onPalette={onPalette} />
        <Dialog open onOpenChange={() => {}}>
          <DialogContent><DialogTitle>Rename</DialogTitle></DialogContent>
        </Dialog>
      </>,
    )
    expect(press({ key: 'n', ...MOD }).defaultPrevented).toBe(true)
    press({ key: 'k', ...MOD })
    expect(onNew).not.toHaveBeenCalled()
    expect(onPalette).not.toHaveBeenCalled()
  })

  it('lets switchers through an overlay unless it refuses', () => {
    const onNew = mock(() => {})
    const onPalette = mock(() => {})
    let dirty = false
    render(
      <>
        <Shortcuts onNew={onNew} onPalette={onPalette} />
        <Overlay open onClose={() => {}} allowSwitch={() => !dirty} label="Settings" />
      </>,
    )
    press({ key: 'n', ...MOD })
    press({ key: 'k', ...MOD })
    expect(onNew).not.toHaveBeenCalled()
    expect(onPalette).toHaveBeenCalledTimes(1)
    dirty = true
    press({ key: 'k', ...MOD })
    expect(onPalette).toHaveBeenCalledTimes(1)
  })

  it('traps Tab in the top modal only', async () => {
    render(
      <>
        <Overlay open onClose={() => {}} label="Lower" />
        <Overlay open onClose={() => {}} label="Upper" />
      </>,
    )
    const last = screen.getByRole('button', { name: 'Upper last' })
    last.focus()
    press({ key: 'Tab' }, last)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Upper first' }))
  })

  it('closes a popover inside a dialog without closing the dialog', () => {
    const closeDialog = mock(() => {})
    const closePopover = mock(() => {})
    const ui = (popoverOpen: boolean) => (
      <Dialog open onOpenChange={(next) => { if (!next) closeDialog() }}>
        <DialogContent>
          <DialogTitle>Schedule</DialogTitle>
          <Popover open={popoverOpen} onOpenChange={(next) => { if (!next) closePopover() }}>
            <PopoverTrigger>Pick a date</PopoverTrigger>
            <PopoverContent>Calendar</PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>
    )
    // The popover opens after its dialog, as it does on a click.
    const { rerender } = render(ui(false))
    rerender(ui(true))
    press({ key: 'Escape' }, document.body)
    expect(closePopover).toHaveBeenCalledTimes(1)
    expect(closeDialog).not.toHaveBeenCalled()
  })

  // One menu at a time: the palette opening closes the popover under it,
  // so Escape then closes the palette and nothing is left behind.
  it('closes the Todos popover when an overlay opens over it', () => {
    const closeTodos = mock((_open: unknown) => {})
    const closeOverlay = mock(() => {})
    const { rerender } = render(
      <>
        <TodosPopover open onOpenChange={closeTodos} todos={[]} />
        <Overlay open={false} onClose={closeOverlay} label="Palette" />
      </>,
    )
    rerender(
      <>
        <TodosPopover open onOpenChange={closeTodos} todos={[]} />
        <Overlay open onClose={closeOverlay} label="Palette" />
      </>,
    )
    expect(closeTodos).toHaveBeenCalledWith(false)
    press({ key: 'Escape' }, document.body)
    expect(closeOverlay).toHaveBeenCalledTimes(1)
    expect(closeTodos).toHaveBeenCalledTimes(1)
  })
})

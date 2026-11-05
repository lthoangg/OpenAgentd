/**
 * A confirm on a phone is an iOS-style alert (``ui/dialog``): a centred 270px
 * card, the title 17px semibold and the message 13px, Cancel and the action
 * side by side under a hairline (three or more stacked, Cancel at the
 * bottom), the destructive action in red text, Cancel focused, no ×. Desktop,
 * a tablet and Android keep the dialog.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const realMatchMedia = window.matchMedia
const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')
const realUserAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')

/** A phone is narrow and touch; a tablet is touch and wide; a desktop is neither. */
function setDevice({ touch, narrow }: { touch: boolean; narrow: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: (query.includes('pointer: coarse') && touch) || (query.includes('max-width') && narrow),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
const phone = () => setDevice({ touch: true, narrow: true })
const tablet = () => setDevice({ touch: true, narrow: false })
const desktop = () => setDevice({ touch: false, narrow: false })

function setPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', { value, configurable: true })
}
function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
}

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
  delete (navigator as unknown as Record<string, unknown>).platform
  delete (navigator as unknown as Record<string, unknown>).userAgent
  if (realPlatform) Object.defineProperty(Navigator.prototype, 'platform', realPlatform)
  if (realUserAgent) Object.defineProperty(Navigator.prototype, 'userAgent', realUserAgent)
})

/** Focus moves on the next animation frame; poll for it (a focus change touches no DOM). */
async function focusLandsOn(element: HTMLElement) {
  for (let i = 0; i < 100 && document.activeElement !== element; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(document.activeElement).toBe(element)
}

const panel = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!
const footer = () => document.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!
const classes = (el: Element) => el.className.split(/\s+/)

function confirm(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  return render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete this session?"
      description={'"Fix updater" and its messages are deleted for good.'}
      confirmLabel="Delete session"
      onConfirm={() => {}}
      {...props}
    />,
  )
}

describe('ConfirmDialog on a phone: an alert', () => {
  it('is a centred 270px card with no ×', () => {
    setPlatform('MacIntel')
    phone()
    confirm()
    expect(panel().hasAttribute('data-alert')).toBe(true)
    expect(classes(panel())).toEqual(expect.arrayContaining(['w-[270px]', 'rounded-xl', 'p-0', 'text-center', 'top-1/2', 'left-1/2']))
    expect(classes(panel())).not.toContain('sm:max-w-sm')
    expect(classes(panel())).not.toContain('p-4')
    expect(document.querySelector('[data-close-button]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('sets the title in the 17px semibold step and the message in the 13px caption step, centred', () => {
    setPlatform('MacIntel')
    phone()
    confirm()
    const title = screen.getByRole('heading', { name: 'Delete this session?' })
    // text-base is 17px on a phone (index.css), text-meta 13px.
    expect(classes(title)).toEqual(expect.arrayContaining(['text-base', 'font-semibold']))
    const message = document.querySelector<HTMLElement>('[data-slot="dialog-description"]')!
    expect(classes(message)).toContain('text-meta')
    expect(classes(message)).not.toContain('text-sm')
    expect(classes(document.querySelector('[data-slot="dialog-header"]')!)).toEqual(expect.arrayContaining(['items-center', 'text-center']))
  })

  it('puts Cancel on the left and the action on the right, side by side under a hairline', () => {
    setPlatform('MacIntel')
    phone()
    confirm()
    const buttons = Array.from(footer().querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Delete session'])
    expect(footer().dataset.buttonStyle).toBe('alert')
    expect(classes(footer())).toEqual(expect.arrayContaining(['flex', 'flex-row', 'border-t']))
    expect(classes(footer())).not.toContain('flex-col-reverse')
    // Each takes half; a hairline sits between them, not after the last.
    expect(footer().className).toContain('[&>[data-slot=button]]:flex-1')
    expect(footer().className).toContain('[&>[data-slot=button]:not(:first-child)]:border-l')
  })

  it('sets the destructive action in red text on the card, never a fill, and Cancel in regular weight', () => {
    setPlatform('MacIntel')
    phone()
    confirm()
    expect(screen.getByRole('button', { name: 'Delete session' }).dataset.variant).toBe('danger')
    const rules = footer().className
    expect(rules).toContain('[&>[data-variant^=danger]]:text-(--color-error)!')
    expect(rules).toContain('[&>[data-slot=button]]:bg-transparent!')
    expect(rules).toContain('[&>[data-slot=button]]:font-normal')
    expect(rules).toContain('[&>[data-slot=button]]:rounded-none')
    // The accent ink is for what is not destructive.
    expect(rules).toContain('[&>[data-slot=button]:not([data-variant^=danger])]:text-(--color-accent)!')
  })

  it('makes the preferred action of a safe confirm semibold', () => {
    setPlatform('MacIntel')
    phone()
    confirm({ tone: 'default', confirmLabel: 'Reset' })
    expect(screen.getByRole('button', { name: 'Reset' }).dataset.variant).toBe('primary')
    expect(footer().className).toContain('[&>[data-variant=primary]]:font-semibold')
  })

  it('focuses Cancel, never the destructive action', async () => {
    setPlatform('MacIntel')
    phone()
    confirm()
    await focusLandsOn(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('focuses a safe confirm, so a keyboard Enter confirms', async () => {
    setPlatform('MacIntel')
    phone()
    confirm({ tone: 'default', confirmLabel: 'Reset' })
    await focusLandsOn(screen.getByRole('button', { name: 'Reset' }))
  })
})

describe('a Dialog used as a confirm', () => {
  function handRolled({ close = false, body = false, alert }: { close?: boolean; body?: boolean; alert?: boolean } = {}) {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent showCloseButton={close} alert={alert}>
          <DialogHeader>
            <DialogTitle>Delete scheduled task</DialogTitle>
            <DialogDescription>It will be permanently deleted.</DialogDescription>
          </DialogHeader>
          {body && <div data-testid="body">A field</div>}
          <DialogFooter>
            <Button variant="default">Cancel</Button>
            <Button variant="danger">Delete task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    )
  }

  it('is an alert on a phone when it is only a header and a footer with no ×', () => {
    setPlatform('MacIntel')
    phone()
    handRolled()
    expect(panel().hasAttribute('data-alert')).toBe(true)
    expect(footer().dataset.buttonStyle).toBe('alert')
    expect(Array.from(footer().querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Cancel', 'Delete task'])
  })

  it('stacks three or more actions, Cancel (first) at the bottom, a hairline between rows', () => {
    setPlatform('MacIntel')
    phone()
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="default">Cancel</Button>
            <Button variant="default">Save draft</Button>
            <Button variant="danger">Discard</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    )
    expect(classes(footer())).toContain('flex-col-reverse')
    expect(classes(footer())).not.toContain('flex-row')
    expect(footer().className).toContain('[&>[data-slot=button]:not(:first-child)]:border-b')
    expect(footer().className).not.toContain('[&>[data-slot=button]]:flex-1')
  })

  it('is not an alert when it has a body, a ×, or says it is not', () => {
    setPlatform('MacIntel')
    phone()
    handRolled({ body: true })
    expect(panel().hasAttribute('data-alert')).toBe(false)
    cleanup()
    handRolled({ close: true })
    expect(panel().hasAttribute('data-alert')).toBe(false)
    expect(document.querySelector('[data-close-button]')).not.toBeNull()
    cleanup()
    handRolled({ alert: false })
    expect(panel().hasAttribute('data-alert')).toBe(false)
  })

  it('is an alert whatever its shape when it says so, and then has no ×', () => {
    setPlatform('MacIntel')
    phone()
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent alert>
          <DialogHeader>
            <DialogTitle>Stop the server?</DialogTitle>
          </DialogHeader>
          <div>Running agents stop.</div>
          <DialogFooter>
            <Button variant="default">Cancel</Button>
            <Button variant="danger">Stop</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    )
    expect(panel().hasAttribute('data-alert')).toBe(true)
    expect(document.querySelector('[data-close-button]')).toBeNull()
  })

  it('focuses Cancel, the first control, when the footer is hand-rolled', async () => {
    setPlatform('MacIntel')
    phone()
    handRolled()
    await focusLandsOn(screen.getByRole('button', { name: 'Cancel' }))
  })
})

describe('everything but a phone keeps the dialog', () => {
  it('keeps the card, its header and the filled footer on a desktop window', () => {
    setPlatform('MacIntel')
    desktop()
    confirm()
    expect(panel().hasAttribute('data-alert')).toBe(false)
    expect(classes(panel())).toEqual(expect.arrayContaining(['w-full', 'sm:max-w-sm', 'rounded-lg', 'p-4']))
    expect(classes(panel())).not.toContain('w-[270px]')
    expect(footer().dataset.buttonStyle).toBe('filled')
    expect(classes(footer())).toEqual(expect.arrayContaining(['flex-col-reverse', 'sm:flex-row', 'sm:justify-end']))
    expect(footer().className).not.toContain('border-t')
    const title = screen.getByRole('heading', { name: 'Delete this session?' })
    expect(classes(title)).toContain('leading-none')
    expect(classes(document.querySelector('[data-slot="dialog-description"]')!)).toContain('text-sm')
    expect(screen.getByRole('button', { name: 'Delete session' }).className).toContain('bg-(--color-error-subtle)')
  })

  it('keeps it on a tablet: touch, but not a phone', () => {
    setPlatform('MacIntel')
    tablet()
    confirm()
    expect(panel().hasAttribute('data-alert')).toBe(false)
    expect(footer().dataset.buttonStyle).toBe('filled')
  })

  it('keeps it in a narrow window with a mouse', () => {
    setPlatform('MacIntel')
    setDevice({ touch: false, narrow: true })
    confirm()
    expect(panel().hasAttribute('data-alert')).toBe(false)
  })

  it('keeps Material\'s row of text buttons on an Android phone', () => {
    setPlatform('Linux armv8l')
    setUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36')
    phone()
    confirm()
    expect(panel().hasAttribute('data-alert')).toBe(false)
    expect(footer().dataset.buttonStyle).toBe('text')
  })

  it('still focuses Cancel for a destructive confirm on desktop', async () => {
    setPlatform('MacIntel')
    desktop()
    confirm()
    await focusLandsOn(screen.getByRole('button', { name: 'Cancel' }))
  })
})

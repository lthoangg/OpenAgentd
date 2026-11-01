/**
 * Dialog buttons follow the host OS (DESIGN.md → Overlays & Dialogs): Cancel
 * before the primary action on macOS, iOS and Linux; the primary action first
 * on Windows; a row of text buttons on Android. The footer is not a separate
 * strip: no border, no fill of its own. The default button follows native
 * alerts: Enter confirms a safe action and never a destructive one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'

const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')
const realUserAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')

function setPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', { value, configurable: true })
}

function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
}

afterEach(() => {
  cleanup()
  // Drop the instance override so the prototype getter shows through again.
  delete (navigator as unknown as Record<string, unknown>).platform
  delete (navigator as unknown as Record<string, unknown>).userAgent
  if (realPlatform) Object.defineProperty(Navigator.prototype, 'platform', realPlatform)
  if (realUserAgent) Object.defineProperty(Navigator.prototype, 'userAgent', realUserAgent)
})

function renderFooter() {
  render(
    <Dialog open onOpenChange={() => {}}>
      <DialogContent>
        <DialogTitle>Delete this session?</DialogTitle>
        <DialogFooter data-testid="footer">
          <button type="button">Cancel</button>
          <button type="button">Delete</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  )
  return screen.getByTestId('footer')
}

describe('DialogFooter', () => {
  it('is not a separate strip: no border and no fill', () => {
    setPlatform('MacIntel')
    const footer = renderFooter()
    expect(footer.className).not.toMatch(/(?:^|\s)border-t(?:\s|$)/)
    expect(footer.className).not.toContain('bg-')
  })

  it('puts Cancel before the primary action on macOS', () => {
    setPlatform('MacIntel')
    const footer = renderFooter()
    expect(footer.dataset.buttonOrder).toBe('cancel-first')
    expect(footer.className).toContain('sm:flex-row')
    expect(footer.className).not.toContain('sm:flex-row-reverse')
  })

  it('puts the primary action first on Windows', () => {
    setPlatform('Win32')
    const footer = renderFooter()
    expect(footer.dataset.buttonOrder).toBe('primary-first')
    expect(footer.className).toContain('sm:flex-row-reverse')
  })

  it('ends in a row of text buttons on Android, never a stack', () => {
    setPlatform('Linux armv8l')
    setUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36')
    const footer = renderFooter()
    expect(footer.dataset.buttonStyle).toBe('text')
    expect(footer.dataset.buttonOrder).toBe('cancel-first')
    expect(footer.className).toContain('flex-row')
    expect(footer.className).not.toContain('flex-col-reverse')
  })
})

/**
 * The dialog moves focus on the next animation frame. Focus changes do not
 * touch the DOM, so ``waitFor`` would only notice on its slow fallback; poll.
 */
async function focusLandsOn(element: HTMLElement) {
  for (let i = 0; i < 100 && document.activeElement !== element; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(document.activeElement).toBe(element)
}

describe('ConfirmDialog default button', () => {
  it('gives focus to a safe confirm, so Enter confirms', async () => {
    setPlatform('MacIntel')
    render(<ConfirmDialog open onOpenChange={() => {}} title="Reset layout?" confirmLabel="Reset" tone="default" onConfirm={() => {}} />)
    const reset = screen.getByRole('button', { name: 'Reset' })
    await focusLandsOn(reset)
  })

  it('never makes a destructive confirm the default: Cancel takes focus', async () => {
    setPlatform('MacIntel')
    render(<ConfirmDialog open onOpenChange={() => {}} title="Delete this session?" confirmLabel="Delete" onConfirm={() => {}} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await focusLandsOn(cancel)
    expect(screen.getByRole('button', { name: 'Delete' }).dataset.variant).toBe('danger')
  })
})

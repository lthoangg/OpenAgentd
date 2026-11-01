/**
 * Dialog buttons follow the host OS (DESIGN.md → Overlays & Dialogs): Cancel
 * before the primary action on macOS, iOS, Linux and Android; the primary
 * action first on Windows. The footer is not a separate strip: no border, no
 * fill of its own.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'

const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')

function setPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', { value, configurable: true })
}

afterEach(() => {
  cleanup()
  // Drop the instance override so the prototype getter shows through again.
  delete (navigator as unknown as Record<string, unknown>).platform
  if (realPlatform) Object.defineProperty(Navigator.prototype, 'platform', realPlatform)
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
})

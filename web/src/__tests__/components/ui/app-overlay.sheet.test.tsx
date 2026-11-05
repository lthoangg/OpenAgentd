/**
 * AppOverlay on a phone: a full-screen modal is a sheet that rises from the
 * bottom and carries a grabber to pull it back down. The command palette (a
 * compact card) and the desktop card have none.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { AppOverlay } from '@/components/ui/app-overlay'

const originalMatchMedia = window.matchMedia

function stubMobile(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

afterEach(() => {
  cleanup()
  window.matchMedia = originalMatchMedia
})

const grabber = () => document.querySelector('[data-slot="sheet-grabber"]')

describe('AppOverlay — phone sheet', () => {
  it('gives a phone modal a grabber to pull it down', () => {
    stubMobile(true)
    render(<AppOverlay open onClose={() => {}} label="Scheduled tasks"><p>Body</p></AppOverlay>)
    expect(grabber()).not.toBeNull()
    expect(grabber()?.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps the desktop card without a grabber', () => {
    stubMobile(false)
    render(<AppOverlay open onClose={() => {}} label="Scheduled tasks"><p>Body</p></AppOverlay>)
    expect(grabber()).toBeNull()
  })

  it('keeps the palette a card on a phone', () => {
    stubMobile(true)
    render(<AppOverlay open onClose={() => {}} label="Command palette" variant="palette"><p>Body</p></AppOverlay>)
    expect(grabber()).toBeNull()
  })
})

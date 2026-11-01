/**
 * Native ``title`` attributes render as the app's tooltip (DESIGN.md →
 * Keyboard focus model): the same look and timing as <Tooltip>, keyboard
 * focus opens it, a press closes it, and the browser's own yellow box never
 * shows. The element keeps its accessible name or description.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TitleTooltipLayer } from '@/components/ui/title-tooltip'
import { OPEN_DELAY_MS, _resetTooltipTimingForTests } from '@/components/ui/tooltip'

const desktopMedia = ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as typeof window.matchMedia

let originalMatchMedia: typeof window.matchMedia
beforeEach(() => {
  originalMatchMedia = window.matchMedia
  window.matchMedia = desktopMedia
  _resetTooltipTimingForTests()
})
afterEach(() => {
  cleanup()
  window.matchMedia = originalMatchMedia
})

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

function renderWith(ui: React.ReactNode) {
  render(<><TitleTooltipLayer />{ui}</>)
}

describe('TitleTooltipLayer', () => {
  it('shows a hovered title as the app tooltip after the native delay', async () => {
    renderWith(<button type="button" title="Pin session">Pin</button>)
    const button = screen.getByRole('button', { name: 'Pin' })

    fireEvent.pointerOver(button, { pointerType: 'mouse' })
    // The browser's own tooltip never gets the chance to show.
    expect(button.hasAttribute('title')).toBe(false)
    await wait(OPEN_DELAY_MS - 150)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await wait(200)
    expect(screen.getByRole('tooltip').textContent).toBe('Pin session')
  })

  it('keeps the title as the name of an icon-only control', () => {
    renderWith(<button type="button" title="Close tab"><svg aria-hidden="true" /></button>)
    const button = screen.getByTitle('Close tab')

    fireEvent.pointerOver(button, { pointerType: 'mouse' })

    expect(button.getAttribute('aria-label')).toBe('Close tab')
  })

  it('keeps the title as the description of a labelled control', () => {
    renderWith(<button type="button" title="Applies after this turn">Plan</button>)
    const button = screen.getByRole('button', { name: 'Plan' })

    fireEvent.pointerOver(button, { pointerType: 'mouse' })

    expect(button.getAttribute('aria-label')).toBeNull()
    expect(button.getAttribute('aria-description')).toBe('Applies after this turn')
  })

  it('closes on a press', async () => {
    renderWith(<button type="button" title="Pin session">Pin</button>)
    const button = screen.getByRole('button', { name: 'Pin' })
    fireEvent.pointerOver(button, { pointerType: 'mouse' })
    await wait(OPEN_DELAY_MS + 50)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    fireEvent.pointerDown(button)

    await wait(200)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('closes when the pointer leaves', async () => {
    renderWith(<button type="button" title="Pin session">Pin</button>)
    const button = screen.getByRole('button', { name: 'Pin' })
    fireEvent.pointerOver(button, { pointerType: 'mouse' })
    await wait(OPEN_DELAY_MS + 50)

    fireEvent.pointerOut(button, { pointerType: 'mouse', relatedTarget: document.body })

    await wait(200)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens for keyboard focus at once, and not for touch', async () => {
    renderWith(<button type="button" title="Pin session">Pin</button>)
    const button = screen.getByRole('button', { name: 'Pin' })

    fireEvent.pointerOver(button, { pointerType: 'touch' })
    await wait(OPEN_DELAY_MS + 50)
    expect(screen.queryByRole('tooltip')).toBeNull()

    // happy-dom has no :focus-visible; mark the focus as keyboard-driven.
    button.matches = ((selector: string) => selector === ':focus-visible' || Element.prototype.matches.call(button, selector)) as typeof button.matches
    fireEvent.focusIn(button)
    await wait(10)
    expect(screen.getByRole('tooltip').textContent).toBe('Pin session')
  })
})

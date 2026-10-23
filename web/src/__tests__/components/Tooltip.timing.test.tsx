/**
 * Native tooltip timing: a hover waits before opening, the next one within
 * the warm window opens at once, a press closes it, and focus opens it only
 * when it came from the keyboard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OPEN_DELAY_MS, Tooltip, TooltipContent, TooltipTrigger, WARM_MS, _resetTooltipTimingForTests } from '@/components/ui/tooltip'

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

function renderPair() {
  render(
    <>
      <Tooltip>
        <TooltipTrigger render={<button type="button">One</button>} />
        <TooltipContent>First hint</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<button type="button">Two</button>} />
        <TooltipContent>Second hint</TooltipContent>
      </Tooltip>
    </>,
  )
  // Handlers sit on the trigger's wrapping span.
  return {
    one: screen.getByRole('button', { name: 'One' }),
    two: screen.getByRole('button', { name: 'Two' }),
  }
}

describe('tooltip timing', () => {
  it('opens a hover after the delay, not before', async () => {
    const { one } = renderPair()
    fireEvent.mouseEnter(one.parentElement!)
    await wait(OPEN_DELAY_MS - 150)
    expect(screen.queryByText('First hint')).toBeNull()
    await wait(200)
    expect(screen.getByText('First hint')).toBeTruthy()
  })

  it('does not open when the pointer leaves before the delay', async () => {
    const { one } = renderPair()
    fireEvent.mouseEnter(one.parentElement!)
    await wait(100)
    fireEvent.mouseLeave(one.parentElement!)
    await wait(OPEN_DELAY_MS)
    expect(screen.queryByText('First hint')).toBeNull()
  })

  it('opens the next tooltip at once within the warm window, then waits again', async () => {
    const { one, two } = renderPair()
    fireEvent.mouseEnter(one.parentElement!)
    await wait(OPEN_DELAY_MS + 50)
    fireEvent.mouseLeave(one.parentElement!)
    fireEvent.mouseEnter(two.parentElement!)
    await act(async () => {})
    expect(screen.getByText('Second hint')).toBeTruthy()

    fireEvent.mouseLeave(two.parentElement!)
    await wait(WARM_MS + 50)
    fireEvent.mouseEnter(one.parentElement!)
    await act(async () => {})
    expect(screen.queryByText('First hint')).toBeNull()
  })

  it('closes on a press', async () => {
    const { one } = renderPair()
    fireEvent.mouseEnter(one.parentElement!)
    await wait(OPEN_DELAY_MS + 50)
    expect(screen.getByText('First hint')).toBeTruthy()
    fireEvent.pointerDown(one)
    await wait(200)
    expect(screen.queryByText('First hint')).toBeNull()
  })

  it('opens on keyboard focus but not on the focus a click gives', async () => {
    const { one, two } = renderPair()
    fireEvent.focus(one)
    await act(async () => {})
    expect(screen.queryByText('First hint')).toBeNull()

    const matches = two.matches.bind(two)
    two.matches = ((selector: string) => selector === ':focus-visible' || matches(selector)) as typeof two.matches
    fireEvent.focus(two)
    await act(async () => {})
    expect(screen.getByText('Second hint')).toBeTruthy()
  })

  it('does not open on focus a script handed over quietly', async () => {
    const { one } = renderPair()
    const matches = one.matches.bind(one)
    one.matches = ((selector: string) => selector === ':focus-visible' || matches(selector)) as typeof one.matches
    one.setAttribute('data-quiet-focus', '')
    fireEvent.focus(one)
    await act(async () => {})
    expect(screen.queryByText('First hint')).toBeNull()
  })
})

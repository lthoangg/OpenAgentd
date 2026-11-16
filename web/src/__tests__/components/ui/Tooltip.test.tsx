import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import '@testing-library/jest-dom'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Tooltip, TooltipTrigger, TooltipContent, OPEN_DELAY_MS } from '@/components/ui/tooltip'

afterEach(cleanup)

describe('Tooltip', () => {
  let originalMatchMedia: typeof window.matchMedia

  beforeEach(() => {
    originalMatchMedia = window.matchMedia
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('renders tooltip content on hover on desktop', async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia

    render(
      <Tooltip>
        <TooltipTrigger>
          <button type="button">Hover me</button>
        </TooltipTrigger>
        <TooltipContent>Help text</TooltipContent>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Hover me' })
    fireEvent.mouseEnter(trigger.parentElement!)

    // Hover opens after OPEN_DELAY_MS, half of waitFor's default 1s budget;
    // a busy CI runner used up the rest. Wait well past the delay.
    await waitFor(
      () => {
        expect(screen.queryByText('Help text')).toBeInTheDocument()
      },
      { timeout: OPEN_DELAY_MS + 2000 },
    )

    // `duration-*` also sets `transition-duration`; with the default
    // `transition-property: all` the first placement (from 0,0) would slide
    // in from the window's top edge. The fade runs on the Web Animations API
    // (usePresenceMotion), so no transition duration belongs on the box.
    const content = screen.getByRole('tooltip')
    expect(content.className).not.toMatch(/(?<![\w-])duration-\(/)
  })

  it('does NOT render tooltip on mobile', async () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia

    render(
      <Tooltip>
        <TooltipTrigger>
          <button type="button">Hover me</button>
        </TooltipTrigger>
        <TooltipContent>Help text</TooltipContent>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'Hover me' })
    fireEvent.mouseEnter(trigger.parentElement!)
    fireEvent.focus(trigger.parentElement!)

    expect(screen.queryByText('Help text')).toBeNull()
  })
})

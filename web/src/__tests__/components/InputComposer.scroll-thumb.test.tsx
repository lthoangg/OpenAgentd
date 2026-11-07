/**
 * A desktop draft grows to six lines, then scrolls inside the box. The box
 * hides its own scrollbar (it would narrow the text under the overlay
 * mirror), so a thin thumb beside the text shows how much more there is
 * and where the view sits (desktop mockup 3.2).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

import { InputComposer } from '@/components/InputComposer'

afterEach(cleanup)

/** Happy DOM has no layout: give the box a content and a visible height. */
function layout(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
}

const thumb = () => document.querySelector<HTMLElement>('[data-composer-scroll-thumb]')

describe('InputComposer — a draft taller than the box', () => {
  it('caps the box at six lines', () => {
    render(<InputComposer onSubmit={() => {}} />)
    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).style.maxHeight).toBe('6lh')
  })

  it('shows a thumb sized to the view that follows the box as it scrolls', () => {
    render(<InputComposer onSubmit={() => {}} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    layout(input, 300, 100)

    fireEvent.scroll(input)
    expect(thumb()?.style.height).toBe('33.33%')
    expect(thumb()?.style.top).toBe('0%')
    expect(thumb()?.getAttribute('aria-hidden')).toBe('true')

    input.scrollTop = 150
    fireEvent.scroll(input)
    expect(thumb()?.style.top).toBe('50%')
  })

  it('shows no thumb while the draft fits', () => {
    render(<InputComposer onSubmit={() => {}} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    layout(input, 44, 44)

    fireEvent.scroll(input)
    expect(thumb()).toBeNull()
  })
})

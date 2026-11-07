/** A phone keeps its own scroll indicator: the desktop thumb never draws there. */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'ios', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'ios', isMacOverlay: false }),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true }))

import { InputComposer } from '@/components/InputComposer'

afterEach(cleanup)

describe('InputComposer on a phone — a draft taller than the box', () => {
  it('draws no desktop scroll thumb', () => {
    render(<InputComposer onSubmit={() => {}} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => 300 })
    Object.defineProperty(input, 'clientHeight', { configurable: true, get: () => 100 })

    fireEvent.scroll(input)
    expect(document.querySelector('[data-composer-scroll-thumb]')).toBeNull()
    expect(input.style.maxHeight).toBe('6lh')
  })
})

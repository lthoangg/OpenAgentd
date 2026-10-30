/**
 * On a phone the composer carries a Session settings button next to Code /
 * Plan, so the model and thinking level are one tap away.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

let mobile = true
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile, MOBILE_QUERY: '(max-width: 767px)' }))

import { InputComposer } from '@/components/InputComposer'

afterEach(() => {
  cleanup()
  mobile = true
})

describe('InputComposer Session settings button', () => {
  it('opens session settings on a phone', () => {
    const onOpen = mock(() => {})
    render(<InputComposer onSubmit={() => {}} interactionMode="code" onInteractionModeChange={() => {}} onOpenSessionSettings={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session settings' }))

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is not shown on desktop, where the status bar opens session settings', () => {
    mobile = false
    render(<InputComposer onSubmit={() => {}} interactionMode="code" onInteractionModeChange={() => {}} onOpenSessionSettings={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Session settings' })).toBeNull()
  })

  it('is not shown while the bar is minimized', () => {
    render(<InputComposer onSubmit={() => {}} minimized onOpenSessionSettings={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Session settings' })).toBeNull()
  })
})

/**
 * On a phone, Send mid-turn is one pill: a tap steers, a long press opens an
 * action sheet with every way to send (mockup J5 5.1). Stop gives a medium
 * haptic (J4).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))
const medium = mock(() => undefined)
mock.module('@/lib/haptics', () => ({
  selectionHapticFeedback: () => undefined,
  softHapticFeedback: () => undefined,
  mediumHapticFeedback: medium,
  alignmentHapticFeedback: () => undefined,
  outcomeHapticFeedback: () => undefined,
  haptic: () => undefined,
}))

import { InputComposer } from '@/components/InputComposer'

afterEach(() => {
  cleanup()
  medium.mockClear()
})

async function typeWhileStreaming() {
  const onSubmit = mock((..._args: unknown[]) => {})
  const user = userEvent.setup()
  render(<InputComposer onSubmit={onSubmit} onStop={() => {}} isStreaming />)
  await user.type(screen.getByLabelText('Message input'), 'follow-up')
  return { onSubmit }
}

describe('InputComposer — Send on a phone while a turn runs', () => {
  it('is one pill with no chevron; a tap steers', async () => {
    const { onSubmit } = await typeWhileStreaming()
    expect(screen.queryByRole('button', { name: 'More ways to send' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Steer the running turn/ }))
    expect(onSubmit.mock.calls[0]?.[3]).toBe('steer')
  })

  it('opens the ways to send on a long press, and the release does not also steer', async () => {
    const { onSubmit } = await typeWhileStreaming()
    const send = screen.getByRole('button', { name: /^Steer the running turn/ })
    const realSetTimeout = window.setTimeout
    let fire: (() => void) | null = null
    window.setTimeout = ((fn: () => void) => { fire = fn; return 1 }) as unknown as typeof window.setTimeout
    fireEvent.pointerDown(send, { pointerType: 'touch', clientX: 5, clientY: 5 })
    window.setTimeout = realSetTimeout
    act(() => fire?.())
    fireEvent.pointerUp(send)
    fireEvent.click(send)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(medium).toHaveBeenCalled()

    const sheet = document.querySelector<HTMLElement>('[data-action-sheet]')!
    expect(sheet.textContent).toContain('Agent is running. How should this message be sent?')
    fireEvent.click(sheet.querySelector('[data-action-sheet-item="after-turn"]')!)
    expect(onSubmit.mock.calls[0]?.[3]).toBe('after-turn')
  })

  it('gives a medium haptic on Stop', () => {
    render(<InputComposer onSubmit={() => {}} onStop={() => {}} isStreaming />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
    expect(medium).toHaveBeenCalledTimes(1)
  })
})

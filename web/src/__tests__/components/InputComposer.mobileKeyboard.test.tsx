/**
 * On a phone, tapping Send must not take focus out of the composer: iOS would
 * drop the soft keyboard after every message.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: true, os: 'ios', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: true, os: 'ios', isMacOverlay: false }),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_QUERY: '(max-width: 767px)' }))

import { InputComposer } from '@/components/InputComposer'

afterEach(cleanup)

describe('InputComposer on a phone — keyboard stays up', () => {
  it('holds the press on Send while the message box has focus, and keeps focus after sending', () => {
    const onSubmit = mock((..._args: unknown[]) => {})
    render(<InputComposer onSubmit={onSubmit} />)
    const box = screen.getByLabelText('Message input') as HTMLTextAreaElement
    box.focus()
    fireEvent.change(box, { target: { value: 'hello' } })

    const send = screen.getByRole('button', { name: 'Send message' })
    const press = fireEvent.pointerDown(send)
    expect(press).toBe(false) // default prevented: focus does not move
    fireEvent.click(send)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(box)
  })

  it('leaves the press alone when the message box was not focused', () => {
    render(<InputComposer onSubmit={() => {}} />)
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hello' } })
    ;(document.activeElement as HTMLElement | null)?.blur()

    expect(fireEvent.pointerDown(screen.getByRole('button', { name: 'Send message' }))).toBe(true)
  })
})

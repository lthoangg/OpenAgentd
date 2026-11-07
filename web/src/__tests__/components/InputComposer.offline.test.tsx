/**
 * While the server does not answer, desktop's Send says so instead of
 * looking ready (desktop mockup 12.1): it is disabled with the reason, Enter
 * sends nothing, and the draft stays in the box for when it is back.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

import { InputComposer } from '@/components/InputComposer'

afterEach(cleanup)

const REASON = "Can't reach the server. Your message stays here."

describe('InputComposer — offline', () => {
  it('keeps the draft and sends nothing while the server is unreachable', async () => {
    const onSubmit = mock((..._args: unknown[]) => {})
    const user = userEvent.setup()
    render(<InputComposer onSubmit={onSubmit} sendBlockedReason={REASON} />)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    await user.type(input, 'run the tests')
    await user.keyboard('{Enter}')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(input.value).toBe('run the tests')
    const send = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.getAttribute('aria-description')).toBe(REASON)
  })

  it('sends once the server answers again', async () => {
    const onSubmit = mock((..._args: unknown[]) => {})
    const user = userEvent.setup()
    const { rerender } = render(<InputComposer onSubmit={onSubmit} sendBlockedReason={REASON} />)
    await user.type(screen.getByLabelText('Message input'), 'run the tests')
    rerender(<InputComposer onSubmit={onSubmit} sendBlockedReason={null} />)
    await user.keyboard('{Enter}')
    expect(onSubmit.mock.calls[0]?.[0]).toBe('run the tests')
  })
})

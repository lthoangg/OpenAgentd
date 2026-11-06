/**
 * On a phone a long press on a prompt opens its actions: Edit and resend,
 * Copy, Revert to here (mockup J5).
 */
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))
const realHaptics = await import('@/lib/haptics')
mock.module('@/lib/haptics', () => ({ ...realHaptics, mediumHapticFeedback: () => undefined }))

const { UserBubble } = await import('@/components/AgentView/UserBubble')

afterEach(cleanup)

async function hold(element: Element) {
  const realSetTimeout = globalThis.setTimeout
  fireEvent.pointerDown(element, { pointerType: 'touch', clientX: 10, clientY: 10 })
  await act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 600)) })
}

describe('UserBubble on a phone', () => {
  it('opens Edit and resend, Copy and Revert to here on a long press', async () => {
    const onEdit = mock(() => {})
    const onRevert = mock(() => {})
    render(<UserBubble content="Fix the build" onEdit={onEdit} onRevert={onRevert} />)
    await hold(screen.getByText('Fix the build'))
    const sheet = screen.getByRole('dialog', { name: 'Prompt' })
    const labels = Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['Edit and resend', 'Copy', 'Revert to here'])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Revert to here' }))
    expect(onRevert).toHaveBeenCalled()
  })

  it('disables Edit and Revert while a turn runs', async () => {
    render(<UserBubble content="Fix the build" onEdit={() => {}} onRevert={() => {}} editLocked />)
    await hold(screen.getByText('Fix the build'))
    const sheet = screen.getByRole('dialog', { name: 'Prompt' })
    expect(within(sheet).getByRole('button', { name: 'Edit and resend' })).toBeDisabled()
    expect(within(sheet).getByRole('button', { name: 'Revert to here' })).toBeDisabled()
  })
})

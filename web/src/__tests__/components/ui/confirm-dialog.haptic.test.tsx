/** A destructive confirm thumps once as it is pressed (lib/haptics: "destructive confirms"); a safe one does not. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const haptics: string[] = []
const realHaptics = await import('@/lib/haptics')
mock.module('@/lib/haptics', () => ({ ...realHaptics, mediumHapticFeedback: () => { haptics.push('medium') } }))

import { ConfirmDialog } from '@/components/ui/confirm-dialog'

beforeEach(() => { haptics.length = 0 })
afterEach(cleanup)

describe('ConfirmDialog haptics', () => {
  it('thumps when a destructive action is confirmed', async () => {
    let confirmed = 0
    render(<ConfirmDialog open onOpenChange={() => {}} title="Delete task?" confirmLabel="Delete task" onConfirm={() => { confirmed += 1 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
    await waitFor(() => expect(confirmed).toBe(1))
    expect(haptics).toEqual(['medium'])
  })

  it('stays quiet for Cancel and for a safe confirm', async () => {
    let confirmed = 0
    render(<ConfirmDialog open onOpenChange={() => {}} title="Leave?" confirmLabel="Leave" tone="default" onConfirm={() => { confirmed += 1 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(confirmed).toBe(1))
    expect(haptics).toEqual([])
  })
})

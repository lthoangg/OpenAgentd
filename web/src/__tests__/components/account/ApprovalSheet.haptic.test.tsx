/**
 * Adding a device ends with Face ID and the sheet closing by itself: the
 * phone gives the system's success pattern when the device was added, and
 * the error one when it was refused.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const haptics: string[] = []
const realHaptics = await import('@/lib/haptics')
mock.module('@/lib/haptics', () => ({ ...realHaptics, outcomeHapticFeedback: (outcome: string) => { haptics.push(outcome) } }))

import { ApprovalSheet, type ApprovalActions } from '@/components/account/ApprovalSheet'

beforeEach(() => { haptics.length = 0 })
afterEach(cleanup)

function actions(confirm: Partial<ApprovalActions['confirm']>): ApprovalActions {
  const idle = { mutate: () => {}, error: null, isPending: false }
  return {
    begin: { ...idle, data: { code: '123456', server: true, client: false } },
    confirm: { ...idle, ...confirm },
    reject: idle,
  }
}

describe('ApprovalSheet haptics', () => {
  it('gives the success pattern once the device is added', () => {
    let closed = 0
    render(<ApprovalSheet enrollmentId="e1" label="Linux · 9C02 E1B7" onClose={() => { closed += 1 }}
      actions={actions({ mutate: (_variables, options) => { options?.onSuccess?.(undefined) } })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Codes match' }))

    expect(closed).toBe(1)
    expect(haptics).toEqual(['success'])
  })

  it('gives the error pattern when adding was refused', () => {
    const { rerender } = render(<ApprovalSheet enrollmentId="e1" label="Linux" onClose={() => {}} actions={actions({})} />)
    expect(haptics).toEqual([])

    rerender(<ApprovalSheet enrollmentId="e1" label="Linux" onClose={() => {}} actions={actions({ error: new Error('Face ID was cancelled') })} />)

    expect(screen.getByRole('alert').textContent).toContain('Face ID was cancelled')
    expect(haptics).toEqual(['error'])
  })
})

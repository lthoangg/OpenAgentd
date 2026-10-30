import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActivePlanSection } from '@/components/ActivePlanSection'
import type { SessionPlan } from '@/api/types'

const PLAN: SessionPlan = { content: '## Summary\nShip the plan file.', updated_at: new Date(Date.now() - 5 * 60_000).toISOString() }

const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
const revoke = mock(() => {})

beforeAll(() => {
  URL.createObjectURL = mock(() => 'blob:plan') as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL
})
afterAll(() => {
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
})
afterEach(cleanup)

describe('ActivePlanSection', () => {
  it('shows when the plan last changed', () => {
    render(<ActivePlanSection plan={PLAN} onClear={() => {}} />)
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('5m')).toBeTruthy()
  })

  it('opens the plan as a document and releases it on close', () => {
    render(<ActivePlanSection plan={PLAN} onClear={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'View plan' }))
    expect(screen.getByRole('dialog', { name: 'File preview: plan.md' })).toBeTruthy()
    expect(screen.getByText(/Ship the plan file\./)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(screen.queryByRole('dialog', { name: 'File preview: plan.md' })).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:plan')
  })

  it('asks before clearing the plan, and clears it on confirm', async () => {
    const onClear = mock(() => {})
    render(<ActivePlanSection plan={PLAN} onClear={onClear} />)
    const clear = screen.getByRole('button', { name: 'Clear plan…' })
    expect(clear.textContent).toBe('Clear…')
    fireEvent.click(clear)

    expect(await screen.findByText('Clear this plan?')).toBeTruthy()
    expect(onClear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear plan' }))
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1))
  })

  it('keeps the plan when the clear confirmation is cancelled', async () => {
    const onClear = mock(() => {})
    render(<ActivePlanSection plan={PLAN} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear plan…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    // Give a (wrongly) confirming click time to land before asserting it did not
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onClear).not.toHaveBeenCalled()
  })

  it('opens the Plan tab instead of a document when it can', () => {
    const onOpen = mock(() => {})
    render(<ActivePlanSection plan={PLAN} onClear={() => {}} onOpen={onOpen} />)
    expect(screen.queryByRole('button', { name: 'View plan' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the revision, and Approved only while the approved revision is current', () => {
    const view = render(<ActivePlanSection plan={{ ...PLAN, revision: 3, approved_revision: 3 }} onClear={() => {}} />)
    expect(screen.getByText('rev 3')).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    view.unmount()

    render(<ActivePlanSection plan={{ ...PLAN, revision: 4, approved_revision: 3 }} onClear={() => {}} />)
    expect(screen.getByText('rev 4')).toBeTruthy()
    expect(screen.queryByText('Approved')).toBeNull()
  })
})

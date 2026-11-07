/**
 * A plan waiting for review on a phone: a bar pinned above the composer
 * that opens the plan (mockup J6 6.2), so it cannot scroll out of sight.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { PinnedPlanReview } = await import('@/components/PlanReview/PlanReviewCard')
const { useAgentStore } = await import('@/stores/useAgentStore')
const { APP_EVENTS } = await import('@/lib/app-events')

afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null })
})

describe('PinnedPlanReview', () => {
  it('opens the plan from a bar above the composer while it awaits approval', () => {
    useAgentStore.setState({
      sessionId: 's1',
      pendingQuestion: { id: 'q', sessionId: 's1', toolCallId: 'c', questions: [], kind: 'plan_review', planRevision: 3 } as never,
    })
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openPlan, opened)
    render(<PinnedPlanReview />)
    expect(screen.getByText('Plan awaiting approval')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View plan' }))
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener(APP_EVENTS.openPlan, opened)
  })

  it('is gone without an open plan review', () => {
    useAgentStore.setState({ sessionId: 's1', pendingQuestion: null })
    const { container } = render(<PinnedPlanReview />)
    expect(container.textContent).toBe('')
  })
})

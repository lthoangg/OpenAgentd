/**
 * On desktop the plan under review also keeps a bar above the composer
 * (desktop mockup 6.3): the Plan tab may be closed or covered, and the run
 * waits on it. View brings the Plan tab forward, where the review is decided.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => false }))

const { PinnedPlanReview } = await import('@/components/PlanReview/PlanReviewCard')
const { useAgentStore } = await import('@/stores/useAgentStore')
const { APP_EVENTS } = await import('@/lib/app-events')

afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null })
})

describe('PinnedPlanReview on desktop', () => {
  it('keeps the plan awaiting approval above the composer', () => {
    useAgentStore.setState({
      sessionId: 's1',
      pendingQuestion: { id: 'q', sessionId: 's1', toolCallId: 'c', questions: [], kind: 'plan_review', planRevision: 2 } as never,
    })
    const opened = mock(() => {})
    window.addEventListener(APP_EVENTS.openPlan, opened)
    render(<PinnedPlanReview />)
    expect(screen.getByText('Plan awaiting approval')).toBeTruthy()
    expect(screen.getByText('rev 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View plan' }))
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener(APP_EVENTS.openPlan, opened)
  })
})

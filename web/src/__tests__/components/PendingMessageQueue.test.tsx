import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PendingMessageQueue } from '@/components/PendingMessageQueue'
import { useTeamStore } from '@/stores/useTeamStore'

const INITIAL_TEAM_STATE = {
  _pendingMessages: [],
  sessionId: 'session-1',
}

afterEach(() => {
  cleanup()
  useTeamStore.setState(INITIAL_TEAM_STATE)
})

describe('PendingMessageQueue', () => {
  it('renders queued messages for the active session only', () => {
    useTeamStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Queued for active session' },
        { id: 'pending-2', sessionId: 'session-2', content: 'Other session' },
      ],
    })

    render(<PendingMessageQueue />)

    expect(screen.getByText('Queued for active session')).toBeTruthy()
    expect(screen.queryByText('Other session')).toBeNull()
  })

  it('allows queued messages to span full width on mobile and caps width from md up', () => {
    useTeamStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Queued message' },
      ],
    })

    const { container } = render(<PendingMessageQueue />)

    const wrapper = container.querySelector("div[class*='max-w-full'][class*='md:max-w-[78%]']")
    expect(wrapper).toBeTruthy()
  })

  it('restores queued text into the composer before removing the pending message', async () => {
    const user = userEvent.setup()
    const restoreListener = mock(() => {})
    window.addEventListener('queue:restore-draft', restoreListener)
    useTeamStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Please edit me' },
      ],
    })

    render(<PendingMessageQueue />)

    await user.click(screen.getByLabelText('Edit queued message'))

    expect(restoreListener).toHaveBeenCalledTimes(1)
    expect(useTeamStore.getState()._pendingMessages).toEqual([])
    window.removeEventListener('queue:restore-draft', restoreListener)
  })
})

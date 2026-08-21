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

  it('shows attachment names on queued messages', () => {
    useTeamStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        {
          id: 'pending-1',
          sessionId: 'session-1',
          content: 'Queued with file',
          attachments: [
            { original_name: 'doc.txt', media_type: 'text/plain', category: 'document' },
          ],
        },
      ],
    })

    render(<PendingMessageQueue />)

    expect(screen.getByText('doc.txt')).toBeTruthy()
  })

  it('restores queued files into the composer on cancel', async () => {
    const user = userEvent.setup()
    const file = new File(['data'], 'doc.txt', { type: 'text/plain' })
    let restoredFiles: File[] | undefined
    const restoreListener = mock((e: unknown) => {
      restoredFiles = (e as CustomEvent<{ files?: File[] }>).detail?.files
    })
    window.addEventListener('queue:restore-draft', restoreListener)
    useTeamStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        {
          id: 'pending-1',
          sessionId: 'session-1',
          content: 'Queued with file',
          attachments: [
            { original_name: 'doc.txt', media_type: 'text/plain', category: 'document' },
          ],
          files: [file],
        },
      ],
    })

    render(<PendingMessageQueue />)

    await user.click(screen.getByLabelText('Edit queued message'))

    expect(restoreListener).toHaveBeenCalledTimes(1)
    expect(restoredFiles).toEqual([file])
    window.removeEventListener('queue:restore-draft', restoreListener)
  })

  it('collapses and expands long queued messages with top-right collapse toggle', async () => {
    const user = userEvent.setup()
    const elevenLines = Array.from({ length: 11 }, (_, i) => `queued-line-${i + 1}`).join('\n')
    useTeamStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        {
          id: 'pending-long',
          sessionId: 'session-1',
          content: elevenLines,
        },
      ],
    })

    const { container } = render(<PendingMessageQueue />)

    // Visible first lines, hidden 11th line
    expect(screen.getByText(/queued-line-1/)).toBeTruthy()
    expect(screen.queryByText(/queued-line-11/)).toBeNull()

    // Positioned tooltip wrapper
    const tooltipWrapper = container.querySelector("span[class*='absolute'][class*='top-1.5'][class*='right-1.5']")
    expect(tooltipWrapper).toBeTruthy()

    // Toggle expand
    const expandBtn = screen.getByRole('button', { name: 'Expand' })
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false')

    await user.click(expandBtn)
    expect(screen.getByText(/queued-line-11/)).toBeTruthy()
    expect(expandBtn.getAttribute('aria-expanded')).toBe('true')

    // Toggle collapse
    const collapseBtn = screen.getByRole('button', { name: 'Collapse' })
    await user.click(collapseBtn)
    expect(screen.queryByText(/queued-line-11/)).toBeNull()
  })
})

/**
 * On a phone, queued messages wait at the end of the transcript as faded
 * bubbles (user request): a tap takes one back into the composer; there is
 * no ✕ and nothing to undo.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

import { PendingMessageQueue } from '@/components/PendingMessageQueue'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'

const INITIAL_AGENT_STATE = useAgentStore.getState()

afterEach(() => {
  cleanup()
  useAgentStore.setState(INITIAL_AGENT_STATE, true)
  useToastStore.setState({ toasts: [] })
})

/** A message the server holds until the turn ends; its cancel succeeds. */
function hold() {
  useAgentStore.setState({
    sessionId: 's1',
    agentStreams: {},
    _pendingMessages: [{ id: 'h1', sessionId: 's1', content: 'Then run lint', heldUntilTurnEnd: true }],
    removePendingMessage: async (id: string) => {
      useAgentStore.setState((s) => ({ _pendingMessages: s._pendingMessages.filter((m) => m.id !== id) }))
      return 'cancelled'
    },
  })
}

describe('PendingMessageQueue on a phone', () => {
  it('shows a faded bubble with its delivery state', () => {
    hold()
    const { container } = render(<PendingMessageQueue />)
    const bubble = container.querySelector('[data-queued-bubble]')!
    expect(bubble.className.split(/\s+/)).toContain('opacity-60')
    expect(bubble.textContent).toContain('Sends when this turn ends')
  })

  it('a tap takes it back into the composer, with no remove button', async () => {
    hold()
    const restored: string[] = []
    const onRestore = (event: Event) => restored.push((event as CustomEvent).detail.content)
    window.addEventListener('queue:restore-draft', onRestore)
    render(<PendingMessageQueue />)

    expect(screen.queryByRole('button', { name: 'Remove queued message' })).toBeNull()
    expect(screen.getByText('Sends when this turn ends · Tap to edit')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit queued message: Then run lint' })) })
    expect(restored).toEqual(['Then run lint'])
    expect(useAgentStore.getState()._pendingMessages).toEqual([])
    expect(useToastStore.getState().toasts).toEqual([])
    window.removeEventListener('queue:restore-draft', onRestore)
  })
})

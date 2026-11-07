/**
 * On a phone, queued messages wait at the end of the transcript as faded
 * bubbles (user request): tap the bubble edits, ✕ removes with Undo.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

import { PendingMessageQueue } from '@/components/PendingMessageQueue'
import { useAgentStore } from '@/stores/useAgentStore'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'
import { useToastStore } from '@/stores/useToastStore'

afterEach(() => {
  cleanup()
  useHeldMessagesStore.setState({ messages: [] })
  useToastStore.setState({ toasts: [] })
})

function hold() {
  useAgentStore.setState({ sessionId: 's1', _pendingMessages: [], agentStreams: {} })
  useHeldMessagesStore.setState({ messages: [{ id: 'h1', sessionId: 's1', content: 'Then run lint' }] as never })
}

describe('PendingMessageQueue on a phone', () => {
  it('shows a faded bubble with its delivery state', () => {
    hold()
    const { container } = render(<PendingMessageQueue />)
    const bubble = container.querySelector('[data-queued-bubble]')!
    expect(bubble.className.split(/\s+/)).toContain('opacity-60')
    expect(bubble.textContent).toContain('Sends when this turn ends')
  })

  it('tap edits, ✕ removes with Undo', () => {
    hold()
    const restored: string[] = []
    const onRestore = (event: Event) => restored.push((event as CustomEvent).detail.content)
    window.addEventListener('queue:restore-draft', onRestore)
    render(<PendingMessageQueue />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }))
    expect(useHeldMessagesStore.getState().messages).toEqual([])
    expect(useToastStore.getState().toasts[0]?.action?.label).toBe('Undo')

    cleanup()
    hold()
    render(<PendingMessageQueue />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message: Then run lint' }))
    expect(restored).toEqual(['Then run lint'])
    window.removeEventListener('queue:restore-draft', onRestore)
  })
})

/**
 * On a phone, queued messages leave the transcript and sit above the
 * composer as one-line chips: tap edits, ✕ removes (mockup J5 5.2).
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
  it('leaves the transcript empty', () => {
    hold()
    const { container } = render(<PendingMessageQueue />)
    expect(container.textContent).toBe('')
  })

  it('shows a chip above the composer; tap edits, ✕ removes with Undo', () => {
    hold()
    const restored: string[] = []
    const onRestore = (event: Event) => restored.push((event as CustomEvent).detail.content)
    window.addEventListener('queue:restore-draft', onRestore)
    render(<PendingMessageQueue placement="composer" />)

    const chip = screen.getByRole('button', { name: 'Edit queued message: Then run lint' })
    expect(chip.textContent).toContain('Queued')
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }))
    expect(useHeldMessagesStore.getState().messages).toEqual([])
    expect(useToastStore.getState().toasts[0]?.action?.label).toBe('Undo')

    cleanup()
    hold()
    render(<PendingMessageQueue placement="composer" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message: Then run lint' }))
    expect(restored).toEqual(['Then run lint'])
    window.removeEventListener('queue:restore-draft', onRestore)
  })
})

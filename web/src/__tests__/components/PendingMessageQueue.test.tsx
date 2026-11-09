import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PendingMessageQueue } from '@/components/PendingMessageQueue'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import { OPEN_SESSION_EVENT } from '@/utils/workspace-messages'

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
const { Composer } = await import('@/components/composer/Composer')

const realFetch = globalThis.fetch
/** The cancel endpoint answers with ``status`` (204 cancelled, 404 already read). */
function answerCancel(status: number) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(status === 204 ? null : JSON.stringify({ detail: 'x' }), { status })),
  ) as unknown as typeof fetch
}

const INITIAL_TEAM_STATE = {
  _pendingMessages: [],
  sessionId: 'session-1',
  leadName: null,
  agentStreams: {},
}

afterEach(() => {
  cleanup()
  useAgentStore.setState(INITIAL_TEAM_STATE)
  useToastStore.setState({ toasts: [] })
  globalThis.fetch = realFetch
})

describe('PendingMessageQueue', () => {
  it('does not re-render on stream deltas while nothing is queued', () => {
    // `agentStreams` is replaced on every 16 ms SSE flush. With an empty queue
    // there is nothing to reconcile, so the component must not subscribe to
    // it — otherwise it flattens every block of every stream per token.
    const onRender = mock(() => {})
    useAgentStore.setState({ sessionId: 'session-1', _pendingMessages: [], agentStreams: {} })
    render(
      <Profiler id="queue" onRender={onRender}>
        <PendingMessageQueue />
      </Profiler>,
    )
    const rendersAfterMount = onRender.mock.calls.length

    for (let i = 0; i < 3; i++) {
      act(() => {
        useAgentStore.setState({
          agentStreams: {
            openagentd: {
              blocks: [],
              currentBlocks: [{ id: `text-${i}`, type: 'text', content: `token ${i}` }],
              status: 'working',
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
            } as never,
          },
        })
      })
    }

    expect(onRender.mock.calls.length).toBe(rendersAfterMount)
  })

  it('does not re-render on stream deltas while a message waits in the queue', () => {
    // Steering mid-turn is when the queue is non-empty and tokens stream; each
    // flush must not re-render it (and re-scan every block of the session).
    const onRender = mock(() => {})
    const stream = (i: number) => ({
      openagentd: {
        blocks: Array.from({ length: 200 }, (_, n) => ({ id: `old-${n}`, type: 'text', content: 'x' })),
        currentBlocks: [{ id: `text-${i}`, type: 'text', content: `token ${i}` }],
        status: 'working',
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      } as never,
    })
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Steer this way' }],
      agentStreams: stream(0),
    })
    render(
      <Profiler id="queue" onRender={onRender}>
        <PendingMessageQueue />
      </Profiler>,
    )
    const rendersAfterMount = onRender.mock.calls.length

    for (let i = 1; i <= 3; i++) {
      act(() => {
        useAgentStore.setState({ agentStreams: stream(i) })
      })
    }

    expect(onRender.mock.calls.length).toBe(rendersAfterMount)
    expect(screen.getByText('Steer this way')).toBeTruthy()
  })

  it('renders queued messages for the active session only', () => {
    useAgentStore.setState({
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

  it('does not render a queued message if it is already present in currentBlocks or blocks', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      leadName: 'openagentd',
      agentStreams: {
        openagentd: {
          blocks: [],
          currentBlocks: [
            { id: 'pending-1', type: 'user', content: 'Already injected message' },
          ],
          status: 'working',
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        } as never,
      },
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Already injected message' },
        { id: 'pending-2', sessionId: 'session-1', content: 'Still waiting message' },
      ],
    })

    render(<PendingMessageQueue />)

    expect(screen.queryByText('Already injected message')).toBeNull()
    expect(screen.getByText('Still waiting message')).toBeTruthy()
  })

  it('does not render a queued message if it is present in a member agent stream', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      leadName: 'lead',
      agentStreams: {
        lead: {
          blocks: [],
          currentBlocks: [],
          status: 'working',
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        } as never,
        worker: {
          blocks: [
            { id: 'pending-member', type: 'user', content: 'Injected on member stream' },
          ],
          currentBlocks: [],
          status: 'working',
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        } as never,
      },
      _pendingMessages: [
        { id: 'pending-member', sessionId: 'session-1', content: 'Injected on member stream' },
      ],
    })

    render(<PendingMessageQueue />)

    expect(screen.queryByText('Injected on member stream')).toBeNull()
  })

  it('shows a queued steer even when an earlier message used the same text', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      leadName: 'openagentd',
      agentStreams: {
        openagentd: {
          blocks: [{ id: 'earlier', type: 'user', content: 'continue' }],
          currentBlocks: [],
          status: 'working',
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        } as never,
      },
      _pendingMessages: [{ id: 'queued', sessionId: 'session-1', content: 'continue' }],
    })

    render(<PendingMessageQueue />)

    expect(screen.getByText('continue')).toBeTruthy()
  })

  it('allows queued messages to span full width on mobile and caps width from md up', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Queued message' },
      ],
    })

    const { container } = render(<PendingMessageQueue />)

    const wrapper = container.querySelector("div[class*='max-w-full'][class*='md:max-w-[78%]']")
    expect(wrapper).toBeTruthy()
  })

  it('restores queued text into the composer once the server has cancelled it', async () => {
    const user = userEvent.setup()
    const restoreListener = mock(() => {})
    window.addEventListener('queue:restore-draft', restoreListener)
    answerCancel(204)
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Please edit me' },
      ],
    })

    render(<PendingMessageQueue />)

    await user.click(screen.getByLabelText('Edit queued message'))

    expect(restoreListener).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState()._pendingMessages).toEqual([])
    window.removeEventListener('queue:restore-draft', restoreListener)
  })

  it('does not hand back a steer the agent read before the cancel landed', async () => {
    const user = userEvent.setup()
    const restoreListener = mock(() => {})
    window.addEventListener('queue:restore-draft', restoreListener)
    answerCancel(404)
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Too late to edit' }],
    })

    render(<PendingMessageQueue />)
    await user.click(screen.getByLabelText('Edit queued message'))

    expect(restoreListener).not.toHaveBeenCalled()
    expect(useAgentStore.getState()._pendingMessages).toEqual([])
    expect(useAgentStore.getState().error).toBeNull()
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Already sent to the agent'])
    window.removeEventListener('queue:restore-draft', restoreListener)
  })

  it('keeps a steer queued when the cancel fails', async () => {
    const user = userEvent.setup()
    const restoreListener = mock(() => {})
    window.addEventListener('queue:restore-draft', restoreListener)
    answerCancel(500)
    useAgentStore.setState({
      sessionId: 'session-1',
      error: null,
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Still queued' }],
    })

    render(<PendingMessageQueue />)
    await user.click(screen.getByLabelText('Edit queued message'))

    expect(restoreListener).not.toHaveBeenCalled()
    expect(useAgentStore.getState()._pendingMessages.map((m) => m.id)).toEqual(['pending-1'])
    expect(useAgentStore.getState().error).toBeTruthy()
    window.removeEventListener('queue:restore-draft', restoreListener)
  })

  it('draws the edit action as a pencil, not a delete cross', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Queued' }],
    })

    render(<PendingMessageQueue />)

    const icon = screen.getByLabelText('Edit queued message').querySelector('svg')
    expect(icon?.getAttribute('class')).toContain('lucide-pencil')
  })

  describe('Remove', () => {
    it('removes a queued steer without handing its text back to the composer', async () => {
      const user = userEvent.setup()
      const restoreListener = mock(() => {})
      window.addEventListener('queue:restore-draft', restoreListener)
      answerCancel(204)
      useAgentStore.setState({
        sessionId: 'session-1',
        _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Never mind this' }],
      })

      render(<PendingMessageQueue />)
      await user.click(screen.getByRole('button', { name: 'Remove queued message' }))

      expect(useAgentStore.getState()._pendingMessages).toEqual([])
      expect(restoreListener).not.toHaveBeenCalled()
      window.removeEventListener('queue:restore-draft', restoreListener)
    })

    it('offers Undo after a removal, which puts the text and files back in the composer', async () => {
      const user = userEvent.setup()
      let restored: { content?: string; files?: File[] } | undefined
      const restoreListener = mock((e: unknown) => {
        restored = (e as CustomEvent<{ content?: string; files?: File[] }>).detail
      })
      window.addEventListener('queue:restore-draft', restoreListener)
      answerCancel(204)
      const file = new File(['data'], 'doc.txt', { type: 'text/plain' })
      useAgentStore.setState({
        sessionId: 'session-1',
        _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Oops', files: [file] }],
      })

      render(<PendingMessageQueue />)
      await user.click(screen.getByRole('button', { name: 'Remove queued message' }))

      const toast = useToastStore.getState().toasts[0]
      expect(toast?.title).toBe('Queued message removed')
      expect(toast?.action?.label).toBe('Undo')
      expect(restoreListener).not.toHaveBeenCalled()
      toast?.action?.onAction()
      expect(restored).toEqual({ content: 'Oops', files: [file] })
      window.removeEventListener('queue:restore-draft', restoreListener)
    })

    it('says so when the agent read the steer before it could be removed', async () => {
      const user = userEvent.setup()
      answerCancel(404)
      useAgentStore.setState({
        sessionId: 'session-1',
        _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Too late' }],
      })

      render(<PendingMessageQueue />)
      await user.click(screen.getByRole('button', { name: 'Remove queued message' }))

      expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Already sent to the agent'])
      expect(useToastStore.getState().toasts[0]?.description).toContain('removed')
      expect(useAgentStore.getState()._pendingMessages).toEqual([])
    })

    it('keeps a steer queued when the cancel fails', async () => {
      const user = userEvent.setup()
      answerCancel(500)
      useAgentStore.setState({
        sessionId: 'session-1',
        error: null,
        _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Still queued' }],
      })

      render(<PendingMessageQueue />)
      await user.click(screen.getByRole('button', { name: 'Remove queued message' }))

      expect(useAgentStore.getState()._pendingMessages.map((m) => m.id)).toEqual(['pending-1'])
      expect(useAgentStore.getState().error).toBeTruthy()
      // The failure is the store's to report; nothing claims the message was removed.
      expect(useToastStore.getState().toasts.map((t) => t.title)).not.toContain('Queued message removed')
    })

    it('removes a message held for the end of the turn, with Undo', async () => {
      const user = userEvent.setup()
      answerCancel(204)
      useAgentStore.setState({
        sessionId: 'session-1',
        _pendingMessages: [{ id: 'held-1', sessionId: 'session-1', content: 'After the turn', heldUntilTurnEnd: true }],
      })

      render(<PendingMessageQueue />)
      await user.click(screen.getByRole('button', { name: 'Remove queued message' }))

      expect(useAgentStore.getState()._pendingMessages).toEqual([])
      expect(screen.queryByText('After the turn')).toBeNull()
      expect(useToastStore.getState().toasts[0]?.action?.label).toBe('Undo')
    })

    it('sits beside Edit on every queued message, drawn as a cross, 24px (the touch floor makes it 36px)', () => {
      useAgentStore.setState({
        sessionId: 'session-1',
        _pendingMessages: [
          { id: 'pending-1', sessionId: 'session-1', content: 'One' },
          { id: 'pending-2', sessionId: 'session-1', content: 'Two' },
        ],
      })

      render(<PendingMessageQueue />)

      const removes = screen.getAllByRole('button', { name: 'Remove queued message' })
      expect(removes).toHaveLength(2)
      expect(screen.getAllByRole('button', { name: 'Edit queued message' })).toHaveLength(2)
      expect(removes[0]?.querySelector('svg')?.getAttribute('class')).toContain('lucide-x')
      // The shared ×: a Button, icon-xs, named for what it does.
      expect(removes[0]?.hasAttribute('data-close-button')).toBe(true)
      expect(removes[0]?.getAttribute('data-slot')).toBe('button')
      expect(removes[0]?.className).toContain('size-6')
      for (const edit of screen.getAllByRole('button', { name: 'Edit queued message' })) {
        expect(edit.getAttribute('data-slot')).toBe('button')
        expect(edit.className).toContain('size-6')
      }
    })

    it('names itself in a tooltip, not a native title', async () => {
      const user = userEvent.setup()
      useAgentStore.setState({
        sessionId: 'session-1',
        _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Queued' }],
      })

      render(<PendingMessageQueue />)
      const remove = screen.getByRole('button', { name: 'Remove queued message' })
      expect(remove.hasAttribute('title')).toBe(false)
      await user.hover(remove)

      expect((await screen.findByRole('tooltip')).textContent).toBe('Remove queued message')
    })
  })

  it('keeps the queued bubble flat: in the tray or the transcript, it does not float', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Queued' }],
    })

    render(<PendingMessageQueue />)

    const bubble = screen.getByText('Queued', { selector: 'p' }).parentElement
    expect(bubble?.className).not.toContain('shadow')
  })

  it('shows attachment names on queued messages', () => {
    useAgentStore.setState({
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
    answerCancel(204)
    const file = new File(['data'], 'doc.txt', { type: 'text/plain' })
    let restoredFiles: File[] | undefined
    const restoreListener = mock((e: unknown) => {
      restoredFiles = (e as CustomEvent<{ files?: File[] }>).detail?.files
    })
    window.addEventListener('queue:restore-draft', restoreListener)
    useAgentStore.setState({
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

  it('lists messages held for the end of the turn after the ones steering it', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Steer me' },
        { id: 'held-1', sessionId: 'session-1', content: 'After the turn', heldUntilTurnEnd: true },
        { id: 'held-2', sessionId: 'session-2', content: 'Other session', heldUntilTurnEnd: true },
      ],
    })

    render(<PendingMessageQueue />)

    const steer = screen.getByText('Steer me')
    const heldBubble = screen.getByText('After the turn')
    expect(steer.compareDocumentPosition(heldBubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Read before the next step')).toBeTruthy()
    expect(screen.getByText('Sends when this turn ends')).toBeTruthy()
    expect(screen.queryByText('Other session')).toBeNull()
  })

  it('labels a message another workspace queued until the turn ends', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'p-held', sessionId: 'session-1', content: 'Then deploy', sentFromWorkspace: 'api', heldUntilTurnEnd: true }],
    })

    render(<PendingMessageQueue />)

    expect(screen.getByText('From api · Sends when this turn ends')).toBeTruthy()
  })

  it('opens the sender of a queued message from its chip, held or not', async () => {
    const opened: unknown[] = []
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_SESSION_EVENT, onOpen)
    try {
      useAgentStore.setState({
        sessionId: 'session-1',
        _pendingMessages: [
          { id: 'p-held', sessionId: 'session-1', content: 'Then deploy', sentFromWorkspace: 'api', sentFromSession: { sessionId: 'api-session', workspace: '/r/api' }, heldUntilTurnEnd: true },
        ],
      })

      render(<PendingMessageQueue />)

      const chip = screen.getByRole('button', { name: 'Open the sending session in api' })
      expect(chip.textContent).toContain('From')
      expect(chip.textContent).toContain('api')
      expect(chip.className).toContain('pointer-coarse:min-h-9')
      // The delivery state stays beside it.
      expect(screen.getByText('· Sends when this turn ends')).toBeTruthy()
      await userEvent.setup().click(chip)
      expect(opened).toEqual([{ sessionId: 'api-session', workspace: '/r/api' }])
    } finally {
      window.removeEventListener(OPEN_SESSION_EVENT, onOpen)
    }
  })

  it('shows no chip for a message the user queued', () => {
    useAgentStore.setState({ sessionId: 'session-1', _pendingMessages: [{ id: 'p-1', sessionId: 'session-1', content: 'Mine' }] })
    render(<PendingMessageQueue />)
    expect(screen.queryByRole('button', { name: /Open the sending session/ })).toBeNull()
  })

  // A steer left queued after a failed turn (its files are on another
  // device) has no running turn to read it.
  it('says a steer left queued after a failed turn goes with the next message', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      leadName: 'lead',
      isAgentWorking: false,
      agentStreams: {
        lead: { blocks: [], currentBlocks: [], status: 'error', usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } } as never,
      },
      _pendingMessages: [{ id: 'q1', sessionId: 'session-1', content: 'see attached' }],
    })

    render(<PendingMessageQueue />)

    expect(screen.getByText('Sends with your next message')).toBeTruthy()
    expect(screen.queryByText('Read before the next step')).toBeNull()
  })

  it('edits a held message by moving it back into the composer, with its files', async () => {
    const user = userEvent.setup()
    const file = new File(['data'], 'doc.txt', { type: 'text/plain' })
    let restored: { content?: string; files?: File[] } | undefined
    const restoreListener = mock((e: unknown) => {
      restored = (e as CustomEvent<{ content?: string; files?: File[] }>).detail
    })
    window.addEventListener('queue:restore-draft', restoreListener)
    answerCancel(204)
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [
        { id: 'pending-1', sessionId: 'session-1', content: 'Steer me' },
        { id: 'held-1', sessionId: 'session-1', content: 'After the turn', files: [file], heldUntilTurnEnd: true },
      ],
    })

    render(<PendingMessageQueue />)
    await user.click(screen.getAllByLabelText('Edit queued message')[1])

    expect(restored).toEqual({ content: 'After the turn', files: [file] })
    expect(useAgentStore.getState()._pendingMessages.map((m) => m.id)).toEqual(['pending-1'])
    window.removeEventListener('queue:restore-draft', restoreListener)
  })

  it('collapses and expands long queued messages with top-right collapse toggle', async () => {
    const user = userEvent.setup()
    const elevenLines = Array.from({ length: 11 }, (_, i) => `queued-line-${i + 1}`).join('\n')
    useAgentStore.setState({
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

/**
 * Queued and steer messages wait in the transcript, under the running turn,
 * faded like any message that has not been sent yet. The composer carries no
 * queue (placement is covered in ``AgentView.footer.test.tsx``).
 */
describe('PendingMessageQueue look', () => {
  it('fades the queued message so it reads as not sent yet', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Steer this way' }],
    })
    render(<PendingMessageQueue />)

    const bubble = screen.getByText('Steer this way').parentElement as HTMLElement
    expect(bubble.className).toContain('opacity-75')
  })

  it('fades a message held until the turn ends the same way', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'held-1', sessionId: 'session-1', content: 'Held for later', heldUntilTurnEnd: true }],
    })
    render(<PendingMessageQueue />)

    const bubble = screen.getByText('Held for later').parentElement as HTMLElement
    expect(bubble.className).toContain('opacity-75')
  })

  it('keeps Edit and Remove at full strength, so they stay easy to read and hit', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Steer this way' }],
    })
    render(<PendingMessageQueue />)

    for (const name of ['Edit queued message', 'Remove queued message']) {
      expect(screen.getByRole('button', { name }).parentElement?.className ?? '').not.toContain('opacity-75')
    }
  })

  it('is not drawn by the composer, docked or new-session', () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Steer this way' }],
    })
    render(<Composer onSubmit={() => {}} />)
    render(<Composer onSubmit={() => {}} placement="inline" />)

    expect(screen.queryByText('Steer this way')).toBeNull()
    expect(document.querySelector('[data-composer-queue]')).toBeNull()
  })
})

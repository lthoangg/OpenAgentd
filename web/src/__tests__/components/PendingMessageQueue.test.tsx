import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PendingMessageQueue } from '@/components/PendingMessageQueue'
import { useAgentStore } from '@/stores/useAgentStore'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'
import { useToastStore } from '@/stores/useToastStore'

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
  useHeldMessagesStore.setState({ messages: [] })
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
      useHeldMessagesStore.getState().hold({ sessionId: 'session-1', content: 'After the turn' })

      render(<PendingMessageQueue />)
      await user.click(screen.getByRole('button', { name: 'Remove queued message' }))

      expect(useHeldMessagesStore.getState().messages).toEqual([])
      expect(screen.queryByText('After the turn')).toBeNull()
      expect(useToastStore.getState().toasts[0]?.action?.label).toBe('Undo')
    })

    it('sits beside Edit on every queued message, drawn as a cross, 24px and 36px on touch', () => {
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
      expect(removes[0]?.className).toContain('md:h-6 md:w-6')
      expect(removes[0]?.className).toContain('pointer-coarse:size-9')
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
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Steer me' }],
    })
    useHeldMessagesStore.getState().hold({ sessionId: 'session-1', content: 'After the turn' })
    useHeldMessagesStore.getState().hold({ sessionId: 'session-2', content: 'Other session' })

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

  it('shows held messages even when nothing is queued server-side', () => {
    useHeldMessagesStore.getState().hold({ sessionId: 'session-1', content: 'After the turn' })

    render(<PendingMessageQueue />)

    expect(screen.getByText('After the turn')).toBeTruthy()
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
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content: 'Steer me' }],
    })
    useHeldMessagesStore.getState().hold({ sessionId: 'session-1', content: 'After the turn', files: [file] })

    render(<PendingMessageQueue />)
    await user.click(screen.getAllByLabelText('Edit queued message')[1])

    expect(restored).toEqual({ content: 'After the turn', files: [file] })
    expect(useHeldMessagesStore.getState().messages).toEqual([])
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
 * A main session has a composer, and the queue lives in its tray, right above
 * the box (the transcript keeps it only where there is no composer; see
 * ``AgentView.footer.test.tsx``).
 */
describe('PendingMessageQueue in the composer tray', () => {
  const realResizeObserver = globalThis.ResizeObserver
  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver
  })

  function queueOne(content = 'Steer this way') {
    useAgentStore.setState({
      sessionId: 'session-1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 'session-1', content }],
    })
  }
  const docked = () => render(<Composer onSubmit={() => {}} queue={<PendingMessageQueue />} />)

  it('renders inside the docked composer, above the message box', () => {
    queueOne()
    docked()

    const tray = screen.getByTestId('docked-composer')
    const queued = within(tray).getByText('Steer this way')
    const box = within(tray).getByLabelText('Message input')
    expect(queued.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(tray).getByRole('button', { name: 'Edit queued message' })).toBeTruthy()
  })

  it('sits inside the element whose height the composer publishes as --composer-h', () => {
    const observed: Element[] = []
    globalThis.ResizeObserver = class {
      observe(target: Element) { observed.push(target) }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    queueOne()
    render(
      <div data-workbench-center="">
        <Composer onSubmit={() => {}} queue={<PendingMessageQueue />} />
      </div>,
    )

    // The measured element is the docked composer; a queue that grows the
    // tray grows it too, and the transcript above simply ends sooner.
    expect(observed).toEqual([screen.getByTestId('docked-composer')])
    expect(observed[0].contains(screen.getByText('Steer this way'))).toBe(true)
  })

  it('takes no room while nothing is queued', () => {
    docked()

    const slot = document.querySelector('[data-composer-queue]') as HTMLElement
    expect(slot.childElementCount).toBe(0)
    // An empty slot is hidden, margin included.
    expect(slot.className).toContain('empty:hidden')
  })

  it('scrolls within a capped height, so a long queue cannot push the box off screen', () => {
    queueOne()
    docked()

    const slot = document.querySelector('[data-composer-queue]') as HTMLElement
    expect(slot.className).toContain('max-h-[30dvh]')
    expect(slot.className).toContain('overflow-y-auto')
  })

  it('is not drawn by the new-session composer, which has no queue', () => {
    queueOne()
    render(<Composer onSubmit={() => {}} placement="inline" queue={<PendingMessageQueue />} />)

    expect(screen.queryByText('Steer this way')).toBeNull()
  })

  it('keeps Remove, with Undo to put the text back in the composer', async () => {
    const user = userEvent.setup()
    let restored: { content?: string } | undefined
    const restoreListener = mock((e: unknown) => {
      restored = (e as CustomEvent<{ content?: string }>).detail
    })
    window.addEventListener('queue:restore-draft', restoreListener)
    answerCancel(204)
    queueOne('Oops, not this')
    docked()

    await user.click(within(screen.getByTestId('docked-composer')).getByRole('button', { name: 'Remove queued message' }))

    expect(useAgentStore.getState()._pendingMessages).toEqual([])
    expect(screen.queryByText('Oops, not this')).toBeNull()
    const toast = useToastStore.getState().toasts[0]
    expect(toast?.title).toBe('Queued message removed')
    expect(toast?.action?.label).toBe('Undo')
    toast?.action?.onAction()
    expect(restored).toEqual({ content: 'Oops, not this', files: undefined })
    window.removeEventListener('queue:restore-draft', restoreListener)
  })
})

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AgentCommandResponse, ContentBlock, MessageResponse } from '@/api/types'

const postAgentCommand = mock(async (): Promise<AgentCommandResponse> => ({ status: 'accepted', session_id: 'session-1', command: 'undo' }))
const postAgentChat = mock(async (..._args: unknown[]) => ({ status: 'accepted', session_id: 'session-1', message_id: 'm-new' }))

mock.module('@/api/client', () => ({
  cancelQueuedMessage: mock(async () => {}),
  postAgentChat,
  postAgentCommand,
  resolveApiUrl: (url: string) => url,
  updateSessionInteractionMode: mock(async () => { throw new Error('not used') }),
  sessionHistory: mock(async () => { throw new Error('not used') }),
  sessionHistorySince: mock(async () => { throw new Error('not used') }),
  agentStatus: mock(async () => { throw new Error('not used') }),
  agentStream: mock(() => {}),
}))

const { useAgentStore } = await import('@/stores/useAgentStore')
const { retryLatestPrompt } = await import('@/components/AgentChatView/retryPrompt')

function undone(id: string, content: string): AgentCommandResponse {
  const message: MessageResponse = {
    id, session_id: 'session-1', role: 'user', content, reasoning_content: null, tool_calls: null,
    tool_call_id: null, name: null, is_summary: false, is_hidden: false, extra: null,
    created_at: '2026-01-01T00:00:00Z', attachments: null,
  }
  return { status: 'accepted', session_id: 'session-1', command: 'undo', message }
}

const prompt: ContentBlock = { id: 'm2', type: 'user', content: 'rename @src/a.ts', extra: { mentions: ['src/a.ts'] } }

beforeEach(() => {
  postAgentCommand.mockReset()
  postAgentCommand.mockImplementation(async () => undone('m2', 'rename @src/a.ts'))
  postAgentChat.mockReset()
  postAgentChat.mockImplementation(async () => ({ status: 'accepted', session_id: 'session-1', message_id: 'm-new' }))
  useAgentStore.setState({
    agentStreams: {
      lead: {
        blocks: [{ id: 'm1', type: 'user', content: 'hi' }, { id: 'a1', type: 'text', content: 'hello' }, prompt, { id: 'a2', type: 'text', content: 'done' }],
        currentBlocks: [], status: 'idle', model: null, lastError: null, currentText: '', currentThinking: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
      },
    },
    leadName: 'lead',
    agentNames: ['lead'],
    sessionId: 'session-1',
    sessionModel: 'openai:gpt-5',
    sessionThinkingLevel: 'high',
    sessionFastMode: false,
    isAgentWorking: false,
    error: null,
    pendingDraft: null,
    _pendingMessages: [],
    _workspace: '/repo',
    _sessionGeneration: 0,
    cacheInvalidations: [],
  })
})

describe('retryLatestPrompt', () => {
  it('rewinds the latest prompt and sends it again with the current model', async () => {
    expect(await retryLatestPrompt('/repo')).toBe(true)

    expect(postAgentCommand).toHaveBeenCalledTimes(1)
    const args = postAgentChat.mock.calls[0]
    expect(args[0]).toBe('rename @src/a.ts')
    expect(args[3]).toBe('/repo')
    expect(args[5]).toBe('openai:gpt-5')
    expect(args[6]).toBe('high')
    expect(args[8]).toEqual(['src/a.ts'])
    expect(useAgentStore.getState().pendingDraft).toBeNull()
  })

  it('hands the prompt back to the composer when the resend fails', async () => {
    postAgentChat.mockImplementation(async () => { throw new Error('offline') })

    expect(await retryLatestPrompt('/repo')).toBe(false)
    expect(useAgentStore.getState().pendingDraft).toEqual({ content: 'rename @src/a.ts', attachments: [] })
  })

  it('does nothing when there is no prompt to retry', async () => {
    useAgentStore.setState((state) => { state.agentStreams.lead.blocks = [] })

    expect(await retryLatestPrompt('/repo')).toBe(false)
    expect(postAgentCommand).not.toHaveBeenCalled()
  })

  it("retries the user's prompt, not a turn the goal started on its own", async () => {
    const goalTurn: ContentBlock = { id: 'g1', type: 'user', content: '<goal_reminder turn="2"/>', extra: { goal_turn: { id: 'goal-1', turn: 2, max_turns: 50 } } }
    useAgentStore.setState((state) => { state.agentStreams.lead.blocks.push(goalTurn, { id: 'a3', type: 'text', content: 'more' }) })

    expect(await retryLatestPrompt('/repo')).toBe(true)
    const args = postAgentChat.mock.calls[0]
    expect(args[0]).toBe('rename @src/a.ts')
  })

  it('hands a failed resend back to the composer as it was written', async () => {
    const earlier: ContentBlock = { id: 'o1', type: 'user', content: 'tests pass' }
    useAgentStore.setState((state) => { state.agentStreams.lead.blocks.push(earlier) })
    postAgentCommand.mockImplementation(async () => undone('o1', 'tests pass'))
    postAgentChat.mockImplementation(async () => { throw new Error('offline') })

    expect(await retryLatestPrompt('/repo')).toBe(false)
    expect(useAgentStore.getState().pendingDraft).toEqual({ content: 'tests pass', attachments: [] })
  })
})

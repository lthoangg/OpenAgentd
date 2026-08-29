import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ContentBlock } from '@/api/types'

const postAgentCommand = mock(async () => ({
  status: 'accepted',
  session_id: 'session-1',
  command: 'compact',
}))

mock.module('@/api/client', () => ({
  cancelQueuedMessage: mock(async () => {}),
  postAgentChat: mock(async () => ({ status: 'accepted', session_id: 'session-1' })),
  postAgentCommand,
  sessionHistory: mock(async () => { throw new Error('not used') }),
  sessionHistorySince: mock(async () => { throw new Error('not used') }),
  agentStatus: mock(async () => { throw new Error('not used') }),
  agentStream: mock(() => {}),
}))

const { useAgentStore } = await import('@/stores/useAgentStore')

function makeStream(overrides: object = {}) {
  return {
    blocks: [] as ContentBlock[],
    currentBlocks: [] as ContentBlock[],
    status: 'idle' as const,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null,
    lastError: null,
    currentText: '',
    currentThinking: '',
    ...overrides,
  }
}

beforeEach(() => {
  postAgentCommand.mockClear()
  useAgentStore.setState({
    agentStreams: {},
    leadName: null,
    agentNames: [],
    liveAgentNames: null,
    sessionId: null,
    isAgentWorking: false,
    isConnected: false,
    error: null,
    _leadRevertTime: null,
    _pendingMessages: [],
    _sessionGeneration: 0,
    cacheInvalidations: [],
    _abortController: null,
    _reconnectTimer: null,
  })
})

describe('compactAgent', () => {
  it('commits the visible branch and clears redo state after undo', async () => {
    const visible = { id: 'visible', type: 'text' as const, content: 'first answer' }
    const reverted = { id: 'reverted', type: 'user' as const, content: 'second' }
    useAgentStore.setState({
      sessionId: 'session-1',
      leadName: 'lead',
      agentNames: ['lead'],
      _leadRevertTime: 1234,
      agentStreams: {
        lead: makeStream({
          blocks: [visible],
          _revertedSuffix: [reverted],
          revertedCount: 1,
          revertedMessages: [{ role: 'user', content: 'second' }],
        }),
      },
    })

    await useAgentStore.getState().compactAgent()

    expect(postAgentCommand).toHaveBeenCalledWith('compact', 'session-1')
    const state = useAgentStore.getState()
    expect(state._leadRevertTime).toBeNull()
    expect(state.agentStreams.lead.blocks).toEqual([visible])
    expect(state.agentStreams.lead._revertedSuffix).toEqual([])
    expect(state.agentStreams.lead.revertedCount).toBe(0)
    expect(state.agentStreams.lead.revertedMessages).toEqual([])
  })
})

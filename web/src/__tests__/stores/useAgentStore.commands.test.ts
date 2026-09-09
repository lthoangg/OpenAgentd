import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AgentCommandResponse, ContentBlock } from '@/api/types'

const postAgentCommand = mock(async (): Promise<AgentCommandResponse> => ({
  status: 'accepted',
  session_id: 'session-1',
  command: 'compact',
}))
const postAgentChat = mock(async () => ({ status: 'accepted', session_id: 'session-1' }))
const sessionHistory = mock(async () => { throw new Error('not used') })

mock.module('@/api/client', () => ({
  cancelQueuedMessage: mock(async () => {}),
  postAgentChat,
  postAgentCommand,
  sessionHistory,
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
  postAgentChat.mockClear()
  sessionHistory.mockClear()
  postAgentCommand.mockImplementation(async () => ({
    status: 'accepted', session_id: 'session-1', command: 'compact',
  }))
  postAgentChat.mockImplementation(async () => ({ status: 'accepted', session_id: 'session-1' }))
  useAgentStore.setState({
    agentStreams: {},
    leadName: null,
    agentNames: [],
    liveAgentNames: null,
    sessionId: null,
    isAgentWorking: false,
    isConnected: false,
    error: null,
    pendingDraft: null,
    _workspace: null,
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

describe('commands completing after session navigation', () => {
  const commands = ['compactAgent', 'undoAgent', 'redoAgent', 'redoAllAgent'] as const
  for (const command of commands) {
    for (const outcome of ['success', 'failure', 'nothing-to-redo'] as const) {
      for (const nextSession of ['session-2', 'session-1']) {
        it(`${command} ignores stale ${outcome} after switching to ${nextSession}`, async () => {
          let resolve!: (response: AgentCommandResponse) => void
          let reject!: (error: Error) => void
          const pending = new Promise<AgentCommandResponse>((res, rej) => {
            resolve = res
            reject = rej
          })
          postAgentCommand.mockImplementation(() => pending)
          useAgentStore.setState({ sessionId: 'session-1', _workspace: '/first' })
          const action = useAgentStore.getState()[command]()
          const nextState = {
            sessionId: nextSession,
            _sessionGeneration: 1,
            _workspace: '/second',
            _leadRevertTime: 1234,
            isAgentWorking: false,
            isConnected: false,
            error: null,
            pendingDraft: { content: 'second draft', attachments: [] },
            agentStreams: {
              lead: makeStream({
                _revertedSuffix: [{ id: 'hidden', type: 'user', content: 'second turn' }],
                revertedCount: 1,
              }),
            },
          }
          useAgentStore.setState(nextState)
          if (outcome === 'success') {
            resolve({
              status: 'accepted', session_id: 'session-1', command: 'undo',
              changed_paths: { added: [], modified: ['file.txt'], removed: [] },
            })
          } else {
            reject(new Error(outcome === 'failure' ? 'request failed' : 'No undone message to redo'))
          }
          expect(await action).toBeUndefined()
          expect(useAgentStore.getState()).toMatchObject(nextState)
          if (outcome === 'success' && command !== 'compactAgent') {
            expect(useAgentStore.getState().cacheInvalidations).toEqual([
              { kind: 'coding_workspace_paths', workspace: '/first', paths: ['file.txt'] },
            ])
          }
        })
      }
    }
  }

  it('stop does not navigate back to the stopped session', async () => {
    let resolve!: (response: { status: string; session_id: string }) => void
    const pending = new Promise<{ status: string; session_id: string }>((res) => { resolve = res })
    postAgentChat.mockImplementation(() => pending)
    useAgentStore.setState({
      sessionId: 'session-1', _workspace: '/first', isAgentWorking: true,
    })
    const action = useAgentStore.getState().stopAgent()
    useAgentStore.setState({ sessionId: 'session-2', _workspace: '/second', _sessionGeneration: 1 })
    resolve({ status: 'accepted', session_id: 'session-1' })
    await action
    expect(useAgentStore.getState().sessionId).toBe('session-2')
    expect(sessionHistory).not.toHaveBeenCalled()
  })
})

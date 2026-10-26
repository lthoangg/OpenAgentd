import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AgentCommandResponse, ContentBlock, MessageResponse } from '@/api/types'

const postAgentCommand = mock(async (): Promise<AgentCommandResponse> => ({
  status: 'accepted',
  session_id: 'session-1',
  command: 'undo',
}))

mock.module('@/api/client', () => ({
  cancelQueuedMessage: mock(async () => {}),
  postAgentChat: mock(async () => ({ status: 'accepted', session_id: 'session-1' })),
  postAgentCommand,
  updateSessionInteractionMode: mock(async () => { throw new Error('not used') }),
  sessionHistory: mock(async () => { throw new Error('not used') }),
  sessionHistorySince: mock(async () => { throw new Error('not used') }),
  agentStatus: mock(async () => { throw new Error('not used') }),
  agentStream: mock(() => {}),
}))

const { useAgentStore } = await import('@/stores/useAgentStore')

const user = (id: string, content: string, extra: Partial<ContentBlock> = {}): ContentBlock => ({ id, type: 'user', content, ...extra })
const reply = (id: string): ContentBlock => ({ id, type: 'text', content: `reply ${id}` })

function undoResponse(id: string, content: string, extra: Record<string, unknown> | null = null): AgentCommandResponse {
  const message: MessageResponse = {
    id, session_id: 'session-1', role: 'user', content, reasoning_content: null, tool_calls: null,
    tool_call_id: null, name: null, is_summary: false, is_hidden: false, extra,
    created_at: '2026-01-01T00:00:00Z', attachments: null,
  }
  return { status: 'accepted', session_id: 'session-1', command: 'undo', message }
}

const HISTORY = [user('m1', 'first'), reply('a1'), user('m2', 'second'), reply('a2'), user('m3', 'third'), reply('a3')]

beforeEach(() => {
  postAgentCommand.mockReset()
  const responses = [undoResponse('m3', 'third'), undoResponse('m2', 'second'), undoResponse('m1', 'first')]
  postAgentCommand.mockImplementation(async () => responses.shift() ?? undoResponse('none', ''))
  useAgentStore.setState({
    agentStreams: {
      lead: {
        blocks: [...HISTORY], currentBlocks: [], status: 'idle', model: null, lastError: null,
        currentText: '', currentThinking: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
      },
    },
    leadName: 'lead',
    agentNames: ['lead'],
    sessionId: 'session-1',
    isAgentWorking: false,
    error: null,
    pendingDraft: null,
    _workspace: '/repo',
    _sessionGeneration: 0,
    cacheInvalidations: [],
  })
})

describe('revertToMessage', () => {
  it('undoes back to an earlier prompt and puts only that prompt in the composer', async () => {
    const drafts: unknown[] = []
    const unsubscribe = useAgentStore.subscribe((state, prev) => {
      if (state.pendingDraft !== prev.pendingDraft && state.pendingDraft) drafts.push(state.pendingDraft)
    })

    const target = await useAgentStore.getState().revertToMessage('m2')
    unsubscribe()

    expect(target?.id).toBe('m2')
    expect(postAgentCommand).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.id)).toEqual(['m1', 'a1'])
    expect(drafts).toEqual([{ content: 'second', attachments: [] }])
  })

  it('can leave the composer alone, for a retry that resends the prompt itself', async () => {
    const target = await useAgentStore.getState().revertToMessage('m3', { restoreDraft: false })

    expect(target?.content).toBe('third')
    expect(postAgentCommand).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().pendingDraft).toBeNull()
  })

  it('restores uploads but not @mention attachments, which the text re-creates', async () => {
    const upload = { url: '/api/files/a.png', filename: 'a.png', source: 'upload' }
    const mention = { url: '/api/files/b.ts', filename: 'b.ts', source: 'mention' }
    useAgentStore.setState((state) => {
      state.agentStreams.lead.blocks[4] = user('m3', 'third @b.ts', { attachments: [upload, mention] })
    })

    await useAgentStore.getState().revertToMessage('m3')

    expect(useAgentStore.getState().pendingDraft).toEqual({ content: 'third @b.ts', attachments: [upload] })
  })

  it('refuses while a turn is running', async () => {
    useAgentStore.setState({ isAgentWorking: true })

    expect(await useAgentStore.getState().revertToMessage('m2')).toBeNull()
    expect(postAgentCommand).not.toHaveBeenCalled()
    expect(String(useAgentStore.getState().error)).toContain('/stop')
  })

  it('stops at the first failed undo', async () => {
    postAgentCommand.mockImplementation(async () => { throw new Error('snapshot failed') })

    expect(await useAgentStore.getState().revertToMessage('m1')).toBeNull()
    expect(postAgentCommand).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().error).toBe('snapshot failed')
  })

  it('ignores a message that is not a visible prompt', async () => {
    expect(await useAgentStore.getState().revertToMessage('a2')).toBeNull()
    expect(await useAgentStore.getState().revertToMessage('missing')).toBeNull()
    expect(postAgentCommand).not.toHaveBeenCalled()
  })
})

describe('undoAgent', () => {
  it('puts an undone prompt back in the composer', async () => {
    await useAgentStore.getState().undoAgent()

    expect(useAgentStore.getState().pendingDraft).toEqual({ content: 'third', attachments: [] })
  })

  it('puts nothing in the composer for a goal turn, whose text is a hidden reminder', async () => {
    postAgentCommand.mockImplementation(async () => undoResponse('m3', '<goal_reminder turn="2">', { goal_turn: { turn: 2, max_turns: 50 } }))

    await useAgentStore.getState().undoAgent()

    expect(useAgentStore.getState().pendingDraft).toBeNull()
  })
})

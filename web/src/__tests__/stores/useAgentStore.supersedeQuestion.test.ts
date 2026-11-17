/**
 * Sending a new message while an `ask_user` card is open supersedes it: the
 * card must close locally even when no `question_dismissed` event arrives.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test'

const postAgentChat = mock(async () => ({ status: 'started', session_id: 's-1', message_id: 'm-1' }))
mock.module('@/api/client', () => ({
  postAgentChat,
  agentStream: mock(() => {}),
  cancelQueuedMessage: mock(async () => ({})),
}))

import { useAgentStore } from '@/stores/useAgentStore'
import { questionCardOf, openQuestion } from '@/stores/useAgentStore/question-state'

beforeEach(() => {
  postAgentChat.mockClear()
  useAgentStore.setState({
    sessionId: 's-1',
    questionCard: questionCardOf({
      id: 'q-1',
      sessionId: 's-1',
      toolCallId: 'call-1',
      questions: [{ question: 'Q?', header: 'Q', multiple: false, options: [] }],
    }),
    resolvedQuestions: {},
  })
})

describe('sendMessage with an open question', () => {
  it('closes the card as superseded', async () => {
    await useAgentStore.getState().sendMessage('hello', undefined, { workspace: '/tmp' })
    const s = useAgentStore.getState()
    expect(openQuestion(s)).toBeNull()
    expect(s.resolvedQuestions['call-1']?.reason).toBe('superseded')
  })
})

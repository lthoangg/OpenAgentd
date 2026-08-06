/**
 * Cold-load hydration for a suspended turn.
 *
 * The SSE replay buffer is in-memory: after a daemon restart it no longer holds
 * the ``question_asked`` event, but the row is still open and the lead is still
 * suspended. The history response carries it instead, so opening the session on
 * a fresh client (reload, second device, restarted daemon) must restore both the
 * card and the lead's ``waiting_input`` status — from the row, not from the
 * stream store's ``running`` flag, which a restart has already forgotten.
 *
 * IMPORTANT: mock.module() MUST appear before the store import, and this file
 * relies on `bun test --parallel` for per-file module-registry isolation.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockTeamHistory = mock(() => Promise.resolve(historyWithQuestion())) as any

const WIRE_QUESTIONS = [
  {
    question: 'Which package manager?',
    header: 'Package manager',
    multiple: false,
    custom: true,
    options: [
      { label: 'pnpm', description: 'Fast', recommended: true },
      { label: 'bun', description: null, recommended: false },
    ],
  },
]

function historyWithQuestion(overrides: object = {}) {
  return {
    lead: {
      id: 'lead-sess',
      agent_name: 'lead',
      title: null,
      model: null,
      thinking_level: null,
      created_at: null,
      updated_at: null,
      running: false, // the daemon restarted: the stream store forgot the turn
      messages: [
        { id: 'm1', role: 'user', content: 'set it up', created_at: '2026-07-01T00:00:00Z' },
      ],
    },
    members: [],
    has_more: false,
    next_cursor: null,
    pending_question: {
      id: 'q-1',
      session_id: 'lead-sess',
      tool_call_id: 'call-1',
      questions: WIRE_QUESTIONS,
      created_at: '2026-07-01T00:00:02Z',
    },
    ...overrides,
  }
}

;(mock as any).module('@/api/client', () => ({
  teamHistory: mockTeamHistory,
  teamHistorySince: mock(() => Promise.resolve({ lead: {}, members: [] })) as any,
  teamStatus: mock(() => Promise.resolve(null)) as any,
  teamStream: mock(() => {}) as any,
  postTeamChat: mock(() => Promise.resolve({ session_id: 'lead-sess' })) as any,
  postTeamCommand: mock(() => Promise.resolve({ status: 'accepted' })) as any,
  cancelQueuedTeamMessage: mock(() => Promise.resolve()) as any,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useTeamStore } from '@/stores/useTeamStore'

beforeEach(() => {
  mockTeamHistory.mockClear()
  mockTeamHistory.mockImplementation(() => Promise.resolve(historyWithQuestion()))
  useTeamStore.getState().newSession()
  useTeamStore.setState({ leadName: 'lead', liveAgentNames: ['lead'] })
})

describe('loadSession — pending question hydration', () => {
  it('restores the card from the history response', async () => {
    await useTeamStore.getState().loadSession('lead-sess')

    const pending = useTeamStore.getState().pendingQuestion
    expect(pending).not.toBeNull()
    expect(pending!.id).toBe('q-1')
    expect(pending!.toolCallId).toBe('call-1')
    expect(pending!.questions[0].options[0].recommended).toBe(true)
    expect(pending!.questions[0].options[1].description).toBeNull()
  })

  it('parks the lead in waiting_input even though the stream store lost the turn', async () => {
    await useTeamStore.getState().loadSession('lead-sess')

    const state = useTeamStore.getState()
    expect(state.agentStreams.lead.status).toBe('waiting_input')
    // The durable row outranks running=false, or the UI would look finished
    // with an unanswered question on screen.
    expect(state.isTeamWorking).toBe(true)
  })

  it('does not start a progress timer for a turn that is not producing tokens', async () => {
    await useTeamStore.getState().loadSession('lead-sess')

    expect(useTeamStore.getState().agentStreams.lead._turnStartedAt).toBeNull()
  })

  it('leaves the card closed when the session has no open question', async () => {
    mockTeamHistory.mockImplementation(() =>
      Promise.resolve(historyWithQuestion({ pending_question: null })),
    )

    await useTeamStore.getState().loadSession('lead-sess')

    expect(useTeamStore.getState().pendingQuestion).toBeNull()
    expect(useTeamStore.getState().agentStreams.lead.status).toBe('idle')
  })

  it('ignores a question payload with no answerable questions', async () => {
    mockTeamHistory.mockImplementation(() =>
      Promise.resolve(
        historyWithQuestion({
          pending_question: {
            id: 'q-2',
            session_id: 'lead-sess',
            tool_call_id: 'call-2',
            questions: [],
            created_at: '2026-07-01T00:00:02Z',
          },
        }),
      ),
    )

    await useTeamStore.getState().loadSession('lead-sess')

    expect(useTeamStore.getState().pendingQuestion).toBeNull()
    expect(useTeamStore.getState().agentStreams.lead.status).toBe('idle')
  })
})

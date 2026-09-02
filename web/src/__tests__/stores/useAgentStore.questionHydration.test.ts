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
const mockSessionHistory = mock(() => Promise.resolve(historyWithQuestion())) as any

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
  sessionHistory: mockSessionHistory,
  sessionHistorySince: mock(() => Promise.resolve({ lead: {}, members: [] })) as any,
  agentStatus: mock(() => Promise.resolve(null)) as any,
  agentStream: mock(() => {}) as any,
  postAgentChat: mock(() => Promise.resolve({ session_id: 'lead-sess' })) as any,
  postAgentCommand: mock(() => Promise.resolve({ status: 'accepted' })) as any,
  cancelQueuedMessage: mock(() => Promise.resolve()) as any,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore, isAwaitingRestartOutput } from '@/stores/useAgentStore'

beforeEach(() => {
  mockSessionHistory.mockClear()
  mockSessionHistory.mockImplementation(() => Promise.resolve(historyWithQuestion()))
  useAgentStore.getState().newSession()
  useAgentStore.setState({ leadName: 'lead', liveAgentNames: ['lead'] })
})

describe('loadSession — pending question hydration', () => {
  it('restores the card from the history response', async () => {
    await useAgentStore.getState().loadSession('lead-sess')

    const pending = useAgentStore.getState().pendingQuestion
    expect(pending).not.toBeNull()
    expect(pending!.id).toBe('q-1')
    expect(pending!.toolCallId).toBe('call-1')
    expect(pending!.questions[0].options[0].recommended).toBe(true)
    expect(pending!.questions[0].options[1].description).toBeNull()
  })

  it('parks the lead in waiting_input even though the stream store lost the turn', async () => {
    await useAgentStore.getState().loadSession('lead-sess')

    const state = useAgentStore.getState()
    expect(state.agentStreams.lead.status).toBe('waiting_input')
    // The durable row outranks running=false, or the UI would look finished
    // with an unanswered question on screen.
    expect(state.isAgentWorking).toBe(true)
  })

  it('does not start a progress timer for a turn that is not producing tokens', async () => {
    await useAgentStore.getState().loadSession('lead-sess')

    expect(useAgentStore.getState().agentStreams.lead._turnStartedAt).toBeNull()
  })

  it('leaves the card closed when the session has no open question', async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve(historyWithQuestion({ pending_question: null })),
    )

    await useAgentStore.getState().loadSession('lead-sess')

    expect(useAgentStore.getState().pendingQuestion).toBeNull()
    expect(useAgentStore.getState().agentStreams.lead.status).toBe('idle')
  })

  /**
   * Reproduces the reported sequence: ask -> daemon restart -> answer. The
   * restart kills the SSE connection, so the reconnecting client misses the
   * resumed turn's deltas *and* its ``done``, and learns the outcome only from
   * this fetch. Nothing else is left to stop the dots.
   */
  describe('a restart pending across the reload', () => {
    function suspendAndResume() {
      useAgentStore.getState()._handleSSEEvent('agent_status', {
        agent: 'lead',
        status: 'waiting_input',
      })
      useAgentStore.getState().markTurnResuming()
      expect(isAwaitingRestartOutput(useAgentStore.getState().agentStreams.lead)).toBe(true)
    }

    it('stops awaiting the restart when the fetch says the turn ended', async () => {
      suspendAndResume()
      mockSessionHistory.mockImplementation(() =>
        Promise.resolve(historyWithQuestion({ pending_question: null, lead: { ...historyWithQuestion().lead, running: false } })),
      )

      await useAgentStore.getState().loadSession('lead-sess')

      expect(isAwaitingRestartOutput(useAgentStore.getState().agentStreams.lead)).toBe(false)
    })

    it('keeps awaiting the restart while the fetch says the turn is still open', async () => {
      // An incidental reload mid-resume must not kill the dots — the turn is
      // genuinely still working, it just has not produced anything yet.
      suspendAndResume()
      mockSessionHistory.mockImplementation(() =>
        Promise.resolve(historyWithQuestion({ pending_question: null, lead: { ...historyWithQuestion().lead, running: true } })),
      )

      await useAgentStore.getState().loadSession('lead-sess')

      expect(isAwaitingRestartOutput(useAgentStore.getState().agentStreams.lead)).toBe(true)
    })

    it('stops awaiting the restart when the turn parks on another question', async () => {
      suspendAndResume()

      await useAgentStore.getState().loadSession('lead-sess')

      expect(isAwaitingRestartOutput(useAgentStore.getState().agentStreams.lead)).toBe(false)
      expect(useAgentStore.getState().agentStreams.lead.status).toBe('waiting_input')
    })
  })

  it('ignores a question payload with no answerable questions', async () => {
    mockSessionHistory.mockImplementation(() =>
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

    await useAgentStore.getState().loadSession('lead-sess')

    expect(useAgentStore.getState().pendingQuestion).toBeNull()
    expect(useAgentStore.getState().agentStreams.lead.status).toBe('idle')
  })
})

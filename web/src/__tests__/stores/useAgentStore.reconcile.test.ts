/**
 * reconcileTurnTail — cheap post-turn reconciliation.
 *
 * A full history page carries up to 100 lead messages plus 100 per member with
 * complete tool output (measured over 1.7 MB on real sessions), nearly all of
 * which the client just received over SSE. This path adopts canonical rows for
 * only the tail the live stream produced, and must fall back to a full load
 * whenever a delta cannot be spliced safely.
 *
 * IMPORTANT: mock.module() MUST appear before the store import (see the note in
 * useAgentStore.async.test.ts) and this file relies on `bun test --parallel` for
 * per-file module-registry isolation.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSessionHistory = mock(() => Promise.resolve(fullHistory())) as any
const mockSessionHistorySince = mock(() => Promise.resolve(deltaHistory())) as any

function leadSession(overrides: object = {}) {
  return {
    id: 'lead-sess',
    agent_name: 'lead',
    title: null,
    model: null,
    thinking_level: null,
    created_at: null,
    updated_at: null,
    messages: [],
    ...overrides,
  }
}

function fullHistory(overrides: object = {}) {
  return {
    lead: leadSession({
      messages: [
        { id: 'm1', role: 'user', content: 'hello', created_at: '2026-07-01T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'hi', created_at: '2026-07-01T00:00:01Z' },
      ],
    }),
    members: [],
    has_more: true,
    next_cursor: 'older-cursor',
    ...overrides,
  }
}

function deltaHistory(overrides: object = {}) {
  return {
    lead: leadSession({
      messages: [
        { id: 'm3', role: 'assistant', content: 'canonical', created_at: '2026-07-01T00:00:05Z' },
      ],
    }),
    members: [],
    has_more: false,
    next_cursor: null,
    truncated: false,
    ...overrides,
  }
}

;(mock as any).module('@/api/client', () => ({
  sessionHistory: mockSessionHistory,
  sessionHistorySince: mockSessionHistorySince,
  agentStatus: mock(() => Promise.resolve(null)) as any,
  agentStream: mock(() => {}) as any,
  postAgentChat: mock(() => Promise.resolve({ session_id: 'lead-sess' })) as any,
  postAgentCommand: mock(() => Promise.resolve({ status: 'accepted' })) as any,
  cancelQueuedMessage: mock(() => Promise.resolve()) as any,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from '@/stores/useAgentStore'

/** Load a baseline page so the watermark and confirmed blocks exist. */
async function seedLoadedSession() {
  useAgentStore.setState({ leadName: 'lead', liveAgentNames: ['lead'] })
  await useAgentStore.getState().loadSession('lead-sess')
}

/** Append a block as if the live stream had committed it on `done`. */
function addUnsyncedBlock(id: string) {
  useAgentStore.setState((state) => {
    const stream = state.agentStreams.lead
    stream.blocks = [
      ...stream.blocks,
      { id, type: 'text', content: 'streamed', timestamp: new Date() },
    ]
    stream._unsyncedBlockIds = [...(stream._unsyncedBlockIds ?? []), id]
    return state
  })
}

beforeEach(() => {
  mockSessionHistory.mockClear()
  mockSessionHistorySince.mockClear()
  mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory()))
  mockSessionHistorySince.mockImplementation(() => Promise.resolve(deltaHistory()))
  useAgentStore.getState().newSession()
})

describe('reconcileTurnTail', () => {
  it('fetches only the delta using the synced watermark', async () => {
    await seedLoadedSession()
    expect(useAgentStore.getState()._syncedThrough).toBe('m2')
    mockSessionHistory.mockClear()

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(mockSessionHistorySince).toHaveBeenCalledWith('lead-sess', 'm2')
    // The whole point: no full page refetch.
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })

  // Delta-boundary regression: a mid-turn loadSession advances the watermark
  // past the assistant row (persisted before its tools finish), so the
  // end-of-turn delta carries only the tool *result* row. That orphaned
  // result must complete the already-confirmed card instead of being
  // silently dropped — otherwise the card stays "running" forever when the
  // live tool_end event was missed (tab sleep / reconnect).
  it('completes a confirmed running tool card from a result-only delta', async () => {
    await seedLoadedSession()
    // The card a mid-turn loadSession reconciled: confirmed, not yet done.
    useAgentStore.setState((state) => {
      const stream = state.agentStreams.lead
      stream.blocks = [
        ...stream.blocks,
        {
          id: 'call-9',
          type: 'tool',
          content: '',
          toolName: 'shell',
          toolCallId: 'call-9',
          toolDone: false,
          timestamp: new Date('2026-07-01T00:00:03Z'),
        },
      ]
      return state
    })
    mockSessionHistorySince.mockImplementation(() =>
      Promise.resolve(
        deltaHistory({
          lead: leadSession({
            messages: [
              {
                id: 'tr-9',
                role: 'tool',
                tool_call_id: 'call-9',
                content: 'late result',
                extra: { duration_ms: 5 },
                created_at: '2026-07-01T00:00:06Z',
              },
            ],
          }),
        }),
      ),
    )

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    const tool = blocks.find((b) => b.type === 'tool' && b.toolCallId === 'call-9')
    expect(tool?.toolDone).toBe(true)
    expect(tool?.toolResult).toBe('late result')
    expect(tool?.serverDurationMs).toBe(5)
  })

  it('replaces stream-committed blocks with the canonical rows', async () => {
    await seedLoadedSession()
    addUnsyncedBlock('client-block-1')
    expect(useAgentStore.getState().agentStreams.lead.blocks).toHaveLength(3)

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    // Confirmed prefix kept, client block dropped, canonical row appended.
    expect(blocks.map((b) => b.content)).toEqual(['hello', 'hi', 'canonical'])
    expect(blocks.some((b) => b.id === 'client-block-1')).toBe(false)
    expect(useAgentStore.getState().agentStreams.lead._unsyncedBlockIds).toEqual([])
  })

  it('preserves provider_status error blocks when reconcileTurnTail runs', async () => {
    await seedLoadedSession()
    useAgentStore.setState((draft) => {
      const stream = draft.agentStreams.lead
      const providerBlock = {
        id: 'provider-err-1',
        type: 'provider_status' as const,
        content: '429 Rate Limit Exceeded',
        extra: { type: 'provider_status', status: 'error', title: 'Rate Limit Exceeded', category: 'provider' },
        timestamp: new Date(),
      }
      stream.blocks.push(providerBlock)
      stream._unsyncedBlockIds = [providerBlock.id]
    })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    expect(blocks.some((b) => b.id === 'provider-err-1')).toBe(true)
    expect(blocks.find((b) => b.id === 'provider-err-1')?.content).toBe('429 Rate Limit Exceeded')
  })

  it('advances the watermark so the next delta starts from the new tail', async () => {
    await seedLoadedSession()

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(useAgentStore.getState()._syncedThrough).toBe('m3')
  })

  it('keeps the older-history pagination cursor a delta knows nothing about', async () => {
    await seedLoadedSession()
    expect(useAgentStore.getState().hasMore).toBe(true)

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(useAgentStore.getState().hasMore).toBe(true)
    expect(useAgentStore.getState().nextCursor).toBe('older-cursor')
  })

  it('keeps an active revert boundary instead of recomputing it from a delta', async () => {
    await seedLoadedSession()
    useAgentStore.setState({ _leadRevertTime: 1_800_000_000_000 })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    // Recomputing would find no boundary row in the delta, clear the boundary,
    // and resurrect every reverted block.
    expect(useAgentStore.getState()._leadRevertTime).toBe(1_800_000_000_000)
  })

  it('drops delta rows at or after the revert boundary', async () => {
    await seedLoadedSession()
    // Boundary before the delta row's timestamp.
    useAgentStore.setState({
      _leadRevertTime: new Date('2026-07-01T00:00:04Z').getTime(),
    })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const contents = useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents).not.toContain('canonical')
  })

  it('falls back to a full load when there is no synced baseline', async () => {
    useAgentStore.setState({ sessionId: 'lead-sess', leadName: 'lead', _syncedThrough: null })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(mockSessionHistory).toHaveBeenCalled()
    expect(mockSessionHistorySince).not.toHaveBeenCalled()
  })

  it('falls back to a full load when the delta is truncated', async () => {
    await seedLoadedSession()
    mockSessionHistory.mockClear()
    mockSessionHistorySince.mockImplementation(() =>
      Promise.resolve(deltaHistory({ truncated: true })),
    )

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(mockSessionHistorySince).toHaveBeenCalled()
    expect(mockSessionHistory).toHaveBeenCalled()
  })

  it('falls back to a full load when the delta request fails', async () => {
    await seedLoadedSession()
    mockSessionHistory.mockClear()
    mockSessionHistorySince.mockImplementation(() => Promise.reject(new Error('boom')))

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(mockSessionHistory).toHaveBeenCalled()
    expect(useAgentStore.getState().error).toBeNull()
  })

  it('falls back to a full load when a turn is still running', async () => {
    await seedLoadedSession()
    mockSessionHistory.mockClear()
    useAgentStore.setState({ isAgentWorking: true })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    // A live turn is still appending blocks; a delta snapshot cannot be spliced.
    expect(mockSessionHistorySince).not.toHaveBeenCalled()
    expect(mockSessionHistory).toHaveBeenCalled()
  })

  it('ignores a delta that resolves after the session changed', async () => {
    await seedLoadedSession()
    mockSessionHistorySince.mockImplementation(async () => {
      useAgentStore.getState().newSession()
      return deltaHistory()
    })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(useAgentStore.getState().sessionId).toBeNull()
  })

  it('adopts member sessions that first appear in the delta', async () => {
    await seedLoadedSession()
    mockSessionHistorySince.mockImplementation(() =>
      Promise.resolve(deltaHistory({
        members: [{
          name: 'explorer#1',
          session_id: 'member-sess',
          messages: [{
            id: 'mm1',
            role: 'assistant',
            content: 'member says',
            created_at: '2026-07-01T00:00:06Z',
          }],
        }],
      })),
    )

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const state = useAgentStore.getState()
    expect(state.agentNames).toContain('explorer#1')
    expect(state.agentStreams['explorer#1'].blocks.map((b) => b.content)).toEqual(['member says'])
  })

  it('does not duplicate pre-compaction content when a turn spans a summarization boundary', async () => {
    // Reproduces: auto-compaction can fire mid-turn ("between model
    // iterations"), sealing whatever text/tools had already streamed into
    // `currentBlocks` plus a divider into `blocks` directly. Unlike `done`,
    // that flush never tagged the sealed blocks as unsynced, so a later
    // reconcile (e.g. after /stop, or a periodic session_turn_completed
    // tail-swap) kept them as "confirmed" and appended the server's
    // canonical parse of that same content right after — duplicating the
    // pre-compaction reply (and doubling the compaction divider).
    //
    // A compacted turn routes through the full page because the summary's
    // anchored seq cannot be inserted by the tail-only delta splice (see the
    // test below), so this asserts the same no-duplication guarantee there.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.agentStreams.lead.currentBlocks = [
        { id: 'local-user', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:02Z') },
      ]
      state.isAgentWorking = true
      return state
    })
    useAgentStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'pre-compaction reply' })
    useAgentStore.getState()._handleSSEEvent('summarization_start', { agent: 'lead' })
    useAgentStore.getState()._handleSSEEvent('summarization_content', { agent: 'lead', text: 'summary text' })
    useAgentStore.getState()._handleSSEEvent('summarization_end', { agent: 'lead', summary: 'summary text' })
    useAgentStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'post-compaction reply' })
    useAgentStore.getState()._handleSSEEvent('done', {})

    // The server persisted the whole turn — pre-compaction reply, the
    // is_summary row, and the post-compaction reply — as canonical rows.
    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        messages: [
          { id: 'm1', role: 'user', content: 'hello', created_at: '2026-07-01T00:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'hi', created_at: '2026-07-01T00:00:01Z' },
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:02Z' },
          { id: 'a1', role: 'assistant', content: 'pre-compaction reply', created_at: '2026-07-01T00:00:02.500Z' },
          { id: 's1', role: 'user', content: 'summary text', is_summary: true, created_at: '2026-07-01T00:00:03Z' },
          { id: 'a2', role: 'assistant', content: 'post-compaction reply', created_at: '2026-07-01T00:00:04Z' },
        ],
      }),
    })))

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const contents = useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents.filter((c) => c === 'message A')).toHaveLength(1)
    expect(contents.filter((c) => c === 'pre-compaction reply')).toHaveLength(1)
    expect(contents.filter((c) => c === 'post-compaction reply')).toHaveLength(1)
    const compactionCount = useAgentStore.getState().agentStreams.lead.blocks.filter((b) => b.type === 'compaction').length
    expect(compactionCount).toBe(1)
  })

  it('does not duplicate the turn when the trailing done lands after the reconcile', async () => {
    // `session_turn_completed` arrives over the *global* SSE connection, which
    // has no ordering guarantee against the session's own stream — so it can be
    // handled while the turn still looks live locally (`isAgentWorking` true,
    // because the trailing `done` has not landed). reconcileTurnTail therefore
    // delegates to loadSession, which must adopt the server's finished turn
    // rather than preserve the live copy and let `done` append it again.
    await seedLoadedSession()
    useAgentStore.setState({ isAgentWorking: true })
    useAgentStore.setState((state) => {
      state.agentStreams.lead.currentBlocks = [
        // Streamed in a moment ago, i.e. before this reconcile's fetch started.
        { id: 'live-1', type: 'text', content: 'hi', timestamp: new Date(Date.now() - 1000) },
      ]
      state.agentStreams.lead.status = 'working'
      return state
    })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')
    // The session's own stream finally catches up.
    useAgentStore.getState()._handleSSEEvent('done', {})

    const contents = useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents.filter((c) => c === 'hi')).toHaveLength(1)
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
  })

  it('takes a full page when an anchored summary cannot be tail-spliced', async () => {
    // The uuid7 delta does return the newly-created summary even though its
    // logical seq is anchored several turns back. UI blocks do not retain seq,
    // so the delta splice cannot insert that divider into the confirmed prefix;
    // one full page is required to establish canonical order.
    await seedLoadedSession()

    useAgentStore.setState({ isAgentWorking: true })
    useAgentStore.getState()._handleSSEEvent('summarization_start', { agent: 'lead' })
    useAgentStore.getState()._handleSSEEvent('summarization_end', { agent: 'lead', summary: 'summary text' })
    useAgentStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'post-compaction reply' })
    useAgentStore.getState()._handleSSEEvent('done', {})

    // Canonical page: the summary sorts back at the boundary it marks.
    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        messages: [
          { id: 'm1', role: 'user', content: 'hello', created_at: '2026-07-01T00:00:00Z' },
          { id: 's1', role: 'user', content: 'summary text', is_summary: true, created_at: '2026-07-01T00:00:00.999Z' },
          { id: 'm2', role: 'assistant', content: 'hi', created_at: '2026-07-01T00:00:01Z' },
          { id: 'a2', role: 'assistant', content: 'post-compaction reply', created_at: '2026-07-01T00:00:04Z' },
        ],
      }),
    })))
    // The delta sees the new anchored summary, but cannot place it before m2.
    mockSessionHistorySince.mockImplementation(() => Promise.resolve(deltaHistory({
      lead: leadSession({
        messages: [
          { id: 's1', role: 'user', content: 'summary text', is_summary: true, created_at: '2026-07-01T00:00:00.999Z' },
          { id: 'a2', role: 'assistant', content: 'post-compaction reply', created_at: '2026-07-01T00:00:04Z' },
        ],
      }),
    })))

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    expect(blocks.filter((b) => b.type === 'compaction')).toHaveLength(1)
    expect(blocks.map((b) => b.content)).toEqual([
      'hello', 'summary text', 'hi', 'post-compaction reply',
    ])
  })

  it('drops a delta a concurrent full load already absorbed', async () => {
    // Reproduces the Stop duplication: pressing Stop makes the backend push
    // `done` on the session stream *and* publish `session_turn_completed` on
    // the global stream, then returns 202. So `reconcileTurnTail` (from the
    // global event) and `loadSession` (from `stopAgent`) run against the same
    // turn concurrently. The delta was fetched against the *old* watermark, so
    // once the full page has installed those same canonical rows, appending the
    // delta on top renders the just-sent user message twice.
    await seedLoadedSession()
    addUnsyncedBlock('client-block-1')

    const canonicalPage = fullHistory({
      lead: leadSession({
        messages: [
          { id: 'm1', role: 'user', content: 'hello', created_at: '2026-07-01T00:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'hi', created_at: '2026-07-01T00:00:01Z' },
          { id: 'm3', role: 'user', content: 'stop me', created_at: '2026-07-01T00:00:05Z' },
        ],
      }),
    })
    mockSessionHistory.mockImplementation(() => Promise.resolve(canonicalPage))
    mockSessionHistorySince.mockImplementation(async () => {
      // The post-Stop reload lands first and installs the canonical page.
      await useAgentStore.getState().loadSession('lead-sess')
      return deltaHistory({
        lead: leadSession({
          messages: [
            { id: 'm3', role: 'user', content: 'stop me', created_at: '2026-07-01T00:00:05Z' },
          ],
        }),
      })
    })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const contents = useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents).toEqual(['hello', 'hi', 'stop me'])
  })

  it('keeps live content that postdates the fetch snapshot', async () => {
    // The mirror case: content streamed in *while the fetch was in flight*
    // cannot be in that snapshot, so it must survive the reload and still be
    // committed by `done`.
    await seedLoadedSession()
    useAgentStore.setState({ isAgentWorking: true })
    mockSessionHistory.mockImplementation(async () => {
      useAgentStore.setState((state) => {
        state.agentStreams.lead.currentBlocks.push({
          id: 'live-2', type: 'text', content: 'arrived later', timestamp: new Date(Date.now() + 1000),
        })
        return state
      })
      return fullHistory()
    })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')
    useAgentStore.getState()._handleSSEEvent('done', {})

    const contents = useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents.filter((c) => c === 'arrived later')).toHaveLength(1)
  })

  it('leaves usage alone — SSE owns it and a delta would undercount', async () => {
    await seedLoadedSession()
    useAgentStore.setState((state) => {
      state.agentStreams.lead.usage = {
        promptTokens: 500, completionTokens: 250, totalTokens: 750, cachedTokens: 0,
      }
      return state
    })

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    expect(useAgentStore.getState().agentStreams.lead.usage.totalTokens).toBe(750)
  })
})

describe('mid-turn loadSession reconciliation', () => {
  /** What the chat area actually renders for an agent: confirmed rows + live tail. */
  const rendered = (agent = 'lead') => {
    const stream = useAgentStore.getState().agentStreams[agent]
    return [...stream.blocks, ...stream.currentBlocks].map((b) => b.content)
  }

  it('does not duplicate the optimistic user message when the server row predates it', async () => {
    // Reproduces the "duplicate user bubble right after send" report.
    //
    // `sendMessage` stamps its optimistic bubble with the *browser* clock,
    // while the persisted row carries the *server* clock. The dedup match
    // required `persisted.timestamp >= optimisticTime`, so whenever the
    // client ran even slightly ahead of the server the match failed and both
    // copies rendered — display-only, because a refresh starts from empty
    // `currentBlocks`. Intermittent by nature: it tracks clock skew, which is
    // why it shows up "sometimes".
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        {
          id: 'user-optimistic',
          type: 'user',
          content: 'message A',
          // Browser clock: 500ms ahead of the server that persisted the row.
          timestamp: new Date('2026-07-01T00:00:10.500Z'),
        },
      ]
      return state
    })

    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
  })

  it('does not duplicate the optimistic user message when its id already matches the persisted row, regardless of clock skew', async () => {
    // sendMessage patches the optimistic bubble's id to the server's
    // message_id as soon as the POST resolves (pending-slice.ts). Once ids
    // match, dedup no longer needs to infer "same message?" from content +
    // a clock-skew time window — it must hold even far outside that window,
    // where the content/time heuristic alone would have failed.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        {
          id: 'ua', // already patched to the real server id by sendMessage
          type: 'user',
          content: 'message A',
          // 10s of clock skew — well outside the old heuristic's 5s window.
          timestamp: new Date('2026-07-01T00:00:20.000Z'),
        },
      ]
      return state
    })

    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
  })

  it('does not duplicate turn content the running snapshot already covers', async () => {
    // Reproduces the "duplicate user message + reply + tools mid-stream"
    // report. The positional `dropSnapshotCoveredBlocks` guard only ran once
    // the server reported the turn finished, so while `running === true` the
    // whole live tail was preserved verbatim and appended to a snapshot that
    // already contained those same rows — the agent loop persists each model
    // iteration as it completes, long before the turn ends.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
      ]
      return state
    })
    // First model iteration streams a reply, which the server then persists
    // while the turn keeps running.
    useAgentStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'step one reply' })

    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
  })

  it('keeps the in-flight tail the running snapshot does not cover yet', async () => {
    // The failure mode the dedup must not cause: the snapshot only covers the
    // committed part of the turn, so text still streaming has to survive the
    // reconcile. Dropping it would blank out the reply mid-stream.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
        { id: 'live-1', type: 'text', content: 'step one reply', timestamp: new Date('2026-07-01T00:00:11.000Z') },
        { id: 'live-2', type: 'text', content: 'partial step two', timestamp: new Date('2026-07-01T00:00:12.000Z') },
      ]
      return state
    })

    // Server has committed the user row and step one; step two is still live.
    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'partial step two')).toHaveLength(1)
  })

  it('still drops covered content when live reasoning was not persisted', async () => {
    // Providers routinely summarize, redact, or drop reasoning, so the live
    // thinking block often has no persisted counterpart. A strict positional
    // scan would stop at that mismatch and leave the reply + tools duplicated.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
        { id: 'live-think', type: 'thinking', content: 'let me think', timestamp: new Date('2026-07-01T00:00:10.500Z') },
        { id: 'live-text', type: 'text', content: 'step one reply', timestamp: new Date('2026-07-01T00:00:11.000Z') },
      ]
      return state
    })

    // Persisted rows carry no reasoning_content — only user + reply.
    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
  })

  it('keeps reasoning that is still streaming past the persisted rows', async () => {
    // Trailing live thinking has no persisted counterpart *yet* — dropping it
    // would blank out the reasoning mid-stream and lose the accumulated text.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
        { id: 'live-text', type: 'text', content: 'step one reply', timestamp: new Date('2026-07-01T00:00:11.000Z') },
        { id: 'live-think', type: 'thinking', content: 'now for step two', timestamp: new Date('2026-07-01T00:00:12.000Z') },
      ]
      return state
    })

    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'now for step two')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
  })

  it('deduplicates a member stream against a running snapshot', async () => {
    // Member turns are anchored by agent-routed (`from_agent`) user rows —
    // members never receive a plain user message, so the lead-only anchor
    // would skip them entirely and leave their tabs duplicated mid-turn.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.worker = {
        ...state.agentStreams.lead,
        blocks: [],
        status: 'working',
        currentBlocks: [
          { id: 'inbox-1', type: 'user', content: 'do the thing', extra: { from_agent: 'lead' }, timestamp: new Date('2026-07-01T00:00:10.000Z') },
          { id: 'live-1', type: 'text', content: 'working on it', timestamp: new Date('2026-07-01T00:00:11.000Z') },
        ],
      }
      return state
    })

    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({ running: true }),
      members: [{
        name: 'worker',
        messages: [
          { id: 'wu', role: 'user', content: 'do the thing', extra: { from_agent: 'lead' }, created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'wa', role: 'assistant', content: 'working on it', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }],
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    expect(rendered('worker').filter((c) => c === 'do the thing')).toHaveLength(1)
    expect(rendered('worker').filter((c) => c === 'working on it')).toHaveLength(1)
  })

  it('does not swallow a re-sent identical message', async () => {
    // The mirror risk of content matching: sending the same text twice must
    // not let the *previous* turn's persisted row cancel the new optimistic
    // bubble. Suffix anchoring covers this — the older row is followed by its
    // own reply, so it cannot align with the head of the live tail.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'yes', timestamp: new Date('2026-07-01T00:00:20.000Z') },
      ]
      return state
    })

    // History still ends with the *first* "yes" turn; the re-send is not
    // persisted yet.
    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'u1', role: 'user', content: 'yes', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'first answer', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    // Both the persisted original and the pending re-send stay visible.
    expect(rendered().filter((c) => c === 'yes')).toHaveLength(2)
  })
})

describe('queued messages mid-turn injection and reconciliation', () => {
  it('preserves tool calls and user messages in correct order when a queued message is injected mid-turn', async () => {
    // Reproduces the "tool calls disappear during streaming when queued messages are injected" issue.
    // Prior turn had thinking, tool call, text. A queued turn start arrives, then history reconciles mid-turn.
    // Tool calls must remain visible and not disappear.
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.leadName = 'lead'
      state._pendingMessages = [
        { id: 'queued-msg-1', sessionId: 'lead-sess', content: 'run follow-up' },
      ]
      state.agentStreams.lead = {
        ...state.agentStreams.lead,
        status: 'working',
        blocks: [],
        currentBlocks: [
          { id: 'think-1', type: 'thinking', content: 'planning tools' },
          { id: 'call-1', type: 'tool', content: '', toolName: 'patch', toolCallId: 'call-1', toolArgs: '{"path": "a.txt"}', toolDone: true, toolResult: 'ok' },
          { id: 'text-1', type: 'text', content: 'done with tool' },
        ],
      }
      return state
    })

    // Queued message is injected:
    useAgentStore.getState()._handleSSEEvent('queued_turn_start', {
      agent: 'lead',
      message_ids: ['queued-msg-1'],
      messages: [{ id: 'queued-msg-1', content: 'run follow-up' }],
    })

    // Prior blocks should be sealed into blocks, and currentBlocks has the injected user message
    const streamAfterInjection = useAgentStore.getState().agentStreams.lead
    expect(streamAfterInjection.blocks.map((b) => b.type)).toEqual(['thinking', 'tool', 'text'])
    expect(streamAfterInjection.blocks.find((b) => b.id === 'call-1')).toBeDefined()
    expect(streamAfterInjection.currentBlocks.map((b) => b.type)).toEqual(['user'])
    expect(streamAfterInjection.currentBlocks[0].id).toBe('queued-msg-1')

    // Now new turn streams more thinking and text
    useAgentStore.getState()._handleSSEEvent('thinking', { agent: 'lead', text: 'second thinking' })
    useAgentStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'second response' })

    // Mid-turn reconcile runs:
    mockSessionHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'u1', role: 'user', content: 'initial prompt', created_at: '2026-07-01T00:00:01Z' },
          { id: 'a1', role: 'assistant', reasoning_content: 'planning tools', content: 'done with tool', tool_calls: [{ id: 'call-1', function: { name: 'patch', arguments: '{"path": "a.txt"}' } }], created_at: '2026-07-01T00:00:02Z' },
          { id: 't1', role: 'tool', tool_call_id: 'call-1', content: 'ok', created_at: '2026-07-01T00:00:03Z' },
          { id: 'queued-msg-1', role: 'user', content: 'run follow-up', created_at: '2026-07-01T00:00:04Z' },
        ],
      }),
    })))

    await useAgentStore.getState().loadSession('lead-sess')

    const finalStream = useAgentStore.getState().agentStreams.lead
    // Tool call is preserved in confirmed blocks
    const toolInBlocks = finalStream.blocks.find((b) => b.type === 'tool')
    expect(toolInBlocks).toBeDefined()
    expect(toolInBlocks?.toolCallId).toBe('call-1')

    // The new turn's live streaming text remains in currentBlocks without duplication
    expect(finalStream.currentBlocks.map((b) => b.type)).toEqual(['thinking', 'text'])
  })

  it('prunes confirmed user messages from _pendingMessages during reconcileTurnTail', async () => {
    await seedLoadedSession()

    useAgentStore.setState((state) => {
      state._syncedThrough = 'msg-watermark-1'
      state._pendingMessages = [
        { id: 'pm-1', sessionId: 'lead-sess', content: 'already ran' },
        { id: 'pm-2', sessionId: 'lead-sess', content: 'still queued' },
      ]
      return state
    })

    mockSessionHistorySince.mockImplementation(() => Promise.resolve({
      truncated: false,
      lead: {
        agent_name: 'lead',
        running: false,
        messages: [
          { id: 'pm-1', role: 'user', content: 'already ran' },
          { id: 'pm-2', role: 'user', kind: 'queued', content: 'still queued', extra: { queue_status: 'queued' } },
        ],
      },
      members: [],
    }))

    await useAgentStore.getState().reconcileTurnTail('lead-sess')

    const pending = useAgentStore.getState()._pendingMessages
    expect(pending.some((m) => m.id === 'pm-1')).toBe(false)
    expect(pending.some((m) => m.id === 'pm-2')).toBe(true)
  })
})

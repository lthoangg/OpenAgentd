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
 * useTeamStore.async.test.ts) and this file relies on `bun test --parallel` for
 * per-file module-registry isolation.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockTeamHistory = mock(() => Promise.resolve(fullHistory())) as any
const mockTeamHistorySince = mock(() => Promise.resolve(deltaHistory())) as any

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
  teamHistory: mockTeamHistory,
  teamHistorySince: mockTeamHistorySince,
  teamStatus: mock(() => Promise.resolve(null)) as any,
  teamStream: mock(() => {}) as any,
  postTeamChat: mock(() => Promise.resolve({ session_id: 'lead-sess' })) as any,
  postTeamCommand: mock(() => Promise.resolve({ status: 'accepted' })) as any,
  cancelQueuedTeamMessage: mock(() => Promise.resolve()) as any,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useTeamStore } from '@/stores/useTeamStore'

/** Load a baseline page so the watermark and confirmed blocks exist. */
async function seedLoadedSession() {
  useTeamStore.setState({ leadName: 'lead', liveAgentNames: ['lead'] })
  await useTeamStore.getState().loadSession('lead-sess')
}

/** Append a block as if the live stream had committed it on `done`. */
function addUnsyncedBlock(id: string) {
  useTeamStore.setState((state) => {
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
  mockTeamHistory.mockClear()
  mockTeamHistorySince.mockClear()
  mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory()))
  mockTeamHistorySince.mockImplementation(() => Promise.resolve(deltaHistory()))
  useTeamStore.getState().newSession()
})

describe('reconcileTurnTail', () => {
  it('fetches only the delta using the synced watermark', async () => {
    await seedLoadedSession()
    expect(useTeamStore.getState()._syncedThrough).toBe('2026-07-01T00:00:01Z')
    mockTeamHistory.mockClear()

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(mockTeamHistorySince).toHaveBeenCalledWith('lead-sess', '2026-07-01T00:00:01Z')
    // The whole point: no full page refetch.
    expect(mockTeamHistory).not.toHaveBeenCalled()
  })

  it('replaces stream-committed blocks with the canonical rows', async () => {
    await seedLoadedSession()
    addUnsyncedBlock('client-block-1')
    expect(useTeamStore.getState().agentStreams.lead.blocks).toHaveLength(3)

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    const blocks = useTeamStore.getState().agentStreams.lead.blocks
    // Confirmed prefix kept, client block dropped, canonical row appended.
    expect(blocks.map((b) => b.content)).toEqual(['hello', 'hi', 'canonical'])
    expect(blocks.some((b) => b.id === 'client-block-1')).toBe(false)
    expect(useTeamStore.getState().agentStreams.lead._unsyncedBlockIds).toEqual([])
  })

  it('advances the watermark so the next delta starts from the new tail', async () => {
    await seedLoadedSession()

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(useTeamStore.getState()._syncedThrough).toBe('2026-07-01T00:00:05Z')
  })

  it('keeps the older-history pagination cursor a delta knows nothing about', async () => {
    await seedLoadedSession()
    expect(useTeamStore.getState().hasMore).toBe(true)

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(useTeamStore.getState().hasMore).toBe(true)
    expect(useTeamStore.getState().nextCursor).toBe('older-cursor')
  })

  it('keeps an active revert boundary instead of recomputing it from a delta', async () => {
    await seedLoadedSession()
    useTeamStore.setState({ _leadRevertTime: 1_800_000_000_000 })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    // Recomputing would find no boundary row in the delta, clear the boundary,
    // and resurrect every reverted block.
    expect(useTeamStore.getState()._leadRevertTime).toBe(1_800_000_000_000)
  })

  it('drops delta rows at or after the revert boundary', async () => {
    await seedLoadedSession()
    // Boundary before the delta row's timestamp.
    useTeamStore.setState({
      _leadRevertTime: new Date('2026-07-01T00:00:04Z').getTime(),
    })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    const contents = useTeamStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents).not.toContain('canonical')
  })

  it('falls back to a full load when there is no synced baseline', async () => {
    useTeamStore.setState({ sessionId: 'lead-sess', leadName: 'lead', _syncedThrough: null })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(mockTeamHistory).toHaveBeenCalled()
    expect(mockTeamHistorySince).not.toHaveBeenCalled()
  })

  it('falls back to a full load when the delta is truncated', async () => {
    await seedLoadedSession()
    mockTeamHistory.mockClear()
    mockTeamHistorySince.mockImplementation(() =>
      Promise.resolve(deltaHistory({ truncated: true })),
    )

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(mockTeamHistorySince).toHaveBeenCalled()
    expect(mockTeamHistory).toHaveBeenCalled()
  })

  it('falls back to a full load when the delta request fails', async () => {
    await seedLoadedSession()
    mockTeamHistory.mockClear()
    mockTeamHistorySince.mockImplementation(() => Promise.reject(new Error('boom')))

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(mockTeamHistory).toHaveBeenCalled()
    expect(useTeamStore.getState().error).toBeNull()
  })

  it('falls back to a full load when a turn is still running', async () => {
    await seedLoadedSession()
    mockTeamHistory.mockClear()
    useTeamStore.setState({ isTeamWorking: true })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    // A live turn is still appending blocks; a delta snapshot cannot be spliced.
    expect(mockTeamHistorySince).not.toHaveBeenCalled()
    expect(mockTeamHistory).toHaveBeenCalled()
  })

  it('ignores a delta that resolves after the session changed', async () => {
    await seedLoadedSession()
    mockTeamHistorySince.mockImplementation(async () => {
      useTeamStore.getState().newSession()
      return deltaHistory()
    })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(useTeamStore.getState().sessionId).toBeNull()
  })

  it('adopts member sessions that first appear in the delta', async () => {
    await seedLoadedSession()
    mockTeamHistorySince.mockImplementation(() =>
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

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    const state = useTeamStore.getState()
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
    // A compacted turn now routes through the full page (the summary row is
    // stored behind the delta watermark — see the test below), so this asserts
    // the same no-duplication guarantee on that path.
    await seedLoadedSession()

    useTeamStore.setState((state) => {
      state.agentStreams.lead.currentBlocks = [
        { id: 'local-user', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:02Z') },
      ]
      state.isTeamWorking = true
      return state
    })
    useTeamStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'pre-compaction reply' })
    useTeamStore.getState()._handleSSEEvent('summarization_start', { agent: 'lead' })
    useTeamStore.getState()._handleSSEEvent('summarization_content', { agent: 'lead', text: 'summary text' })
    useTeamStore.getState()._handleSSEEvent('summarization_end', { agent: 'lead', summary: 'summary text' })
    useTeamStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'post-compaction reply' })
    useTeamStore.getState()._handleSSEEvent('done', {})

    // The server persisted the whole turn — pre-compaction reply, the
    // is_summary row, and the post-compaction reply — as canonical rows.
    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
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

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    const contents = useTeamStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents.filter((c) => c === 'message A')).toHaveLength(1)
    expect(contents.filter((c) => c === 'pre-compaction reply')).toHaveLength(1)
    expect(contents.filter((c) => c === 'post-compaction reply')).toHaveLength(1)
    const compactionCount = useTeamStore.getState().agentStreams.lead.blocks.filter((b) => b.type === 'compaction').length
    expect(compactionCount).toBe(1)
  })

  it('does not duplicate the turn when the trailing done lands after the reconcile', async () => {
    // `session_turn_completed` arrives over the *global* SSE connection, which
    // has no ordering guarantee against the session's own stream — so it can be
    // handled while the turn still looks live locally (`isTeamWorking` true,
    // because the trailing `done` has not landed). reconcileTurnTail therefore
    // delegates to loadSession, which must adopt the server's finished turn
    // rather than preserve the live copy and let `done` append it again.
    await seedLoadedSession()
    useTeamStore.setState({ isTeamWorking: true })
    useTeamStore.setState((state) => {
      state.agentStreams.lead.currentBlocks = [
        // Streamed in a moment ago, i.e. before this reconcile's fetch started.
        { id: 'live-1', type: 'text', content: 'hi', timestamp: new Date(Date.now() - 1000) },
      ]
      state.agentStreams.lead.status = 'working'
      return state
    })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')
    // The session's own stream finally catches up.
    useTeamStore.getState()._handleSSEEvent('done', {})

    const contents = useTeamStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents.filter((c) => c === 'hi')).toHaveLength(1)
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
  })

  it('takes a full page when the turn compacted, because the summary row predates the delta', async () => {
    // The summary row is stored at the compaction *boundary* — one microsecond
    // ahead of the oldest message the summariser kept (see
    // `_summary_anchor_ids` in app/agent/checkpointer.py). That boundary sits
    // several turns back, so the row is *older* than the delta watermark and
    // `teamHistorySince` cannot return it. Swapping the tail would then drop the
    // locally-created divider with nothing to replace it, and the "Session
    // compacted" marker would vanish until the next full page load.
    await seedLoadedSession()

    useTeamStore.setState({ isTeamWorking: true })
    useTeamStore.getState()._handleSSEEvent('summarization_start', { agent: 'lead' })
    useTeamStore.getState()._handleSSEEvent('summarization_end', { agent: 'lead', summary: 'summary text' })
    useTeamStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'post-compaction reply' })
    useTeamStore.getState()._handleSSEEvent('done', {})

    // Canonical page: the summary sorts back at the boundary it marks.
    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        messages: [
          { id: 'm1', role: 'user', content: 'hello', created_at: '2026-07-01T00:00:00Z' },
          { id: 's1', role: 'user', content: 'summary text', is_summary: true, created_at: '2026-07-01T00:00:00.999Z' },
          { id: 'm2', role: 'assistant', content: 'hi', created_at: '2026-07-01T00:00:01Z' },
          { id: 'a2', role: 'assistant', content: 'post-compaction reply', created_at: '2026-07-01T00:00:04Z' },
        ],
      }),
    })))
    // The delta can only ever see what postdates the watermark.
    mockTeamHistorySince.mockImplementation(() => Promise.resolve(deltaHistory({
      lead: leadSession({
        messages: [
          { id: 'a2', role: 'assistant', content: 'post-compaction reply', created_at: '2026-07-01T00:00:04Z' },
        ],
      }),
    })))

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    const blocks = useTeamStore.getState().agentStreams.lead.blocks
    expect(blocks.filter((b) => b.type === 'compaction')).toHaveLength(1)
    expect(blocks.map((b) => b.content)).toEqual([
      'hello', 'summary text', 'hi', 'post-compaction reply',
    ])
  })

  it('drops a delta a concurrent full load already absorbed', async () => {
    // Reproduces the Stop duplication: pressing Stop makes the backend push
    // `done` on the session stream *and* publish `session_turn_completed` on
    // the global stream, then returns 202. So `reconcileTurnTail` (from the
    // global event) and `loadSession` (from `stopTeam`) run against the same
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
    mockTeamHistory.mockImplementation(() => Promise.resolve(canonicalPage))
    mockTeamHistorySince.mockImplementation(async () => {
      // The post-Stop reload lands first and installs the canonical page.
      await useTeamStore.getState().loadSession('lead-sess')
      return deltaHistory({
        lead: leadSession({
          messages: [
            { id: 'm3', role: 'user', content: 'stop me', created_at: '2026-07-01T00:00:05Z' },
          ],
        }),
      })
    })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    const contents = useTeamStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents).toEqual(['hello', 'hi', 'stop me'])
  })

  it('keeps live content that postdates the fetch snapshot', async () => {
    // The mirror case: content streamed in *while the fetch was in flight*
    // cannot be in that snapshot, so it must survive the reload and still be
    // committed by `done`.
    await seedLoadedSession()
    useTeamStore.setState({ isTeamWorking: true })
    mockTeamHistory.mockImplementation(async () => {
      useTeamStore.setState((state) => {
        state.agentStreams.lead.currentBlocks.push({
          id: 'live-2', type: 'text', content: 'arrived later', timestamp: new Date(Date.now() + 1000),
        })
        return state
      })
      return fullHistory()
    })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')
    useTeamStore.getState()._handleSSEEvent('done', {})

    const contents = useTeamStore.getState().agentStreams.lead.blocks.map((b) => b.content)
    expect(contents.filter((c) => c === 'arrived later')).toHaveLength(1)
  })

  it('leaves usage alone — SSE owns it and a delta would undercount', async () => {
    await seedLoadedSession()
    useTeamStore.setState((state) => {
      state.agentStreams.lead.usage = {
        promptTokens: 500, completionTokens: 250, totalTokens: 750, cachedTokens: 0,
      }
      return state
    })

    await useTeamStore.getState().reconcileTurnTail('lead-sess')

    expect(useTeamStore.getState().agentStreams.lead.usage.totalTokens).toBe(750)
  })
})

describe('mid-turn loadSession reconciliation', () => {
  /** What the chat area actually renders for an agent: confirmed rows + live tail. */
  const rendered = (agent = 'lead') => {
    const stream = useTeamStore.getState().agentStreams[agent]
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

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
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

    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
        ],
      }),
    })))

    await useTeamStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
  })

  it('does not duplicate the optimistic user message when its id already matches the persisted row, regardless of clock skew', async () => {
    // sendMessage patches the optimistic bubble's id to the server's
    // message_id as soon as the POST resolves (pending-slice.ts). Once ids
    // match, dedup no longer needs to infer "same message?" from content +
    // a clock-skew time window — it must hold even far outside that window,
    // where the content/time heuristic alone would have failed.
    await seedLoadedSession()

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
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

    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
        ],
      }),
    })))

    await useTeamStore.getState().loadSession('lead-sess')

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

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
      ]
      return state
    })
    // First model iteration streams a reply, which the server then persists
    // while the turn keeps running.
    useTeamStore.getState()._handleSSEEvent('message', { agent: 'lead', text: 'step one reply' })

    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useTeamStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
  })

  it('keeps the in-flight tail the running snapshot does not cover yet', async () => {
    // The failure mode the dedup must not cause: the snapshot only covers the
    // committed part of the turn, so text still streaming has to survive the
    // reconcile. Dropping it would blank out the reply mid-stream.
    await seedLoadedSession()

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
        { id: 'live-1', type: 'text', content: 'step one reply', timestamp: new Date('2026-07-01T00:00:11.000Z') },
        { id: 'live-2', type: 'text', content: 'partial step two', timestamp: new Date('2026-07-01T00:00:12.000Z') },
      ]
      return state
    })

    // Server has committed the user row and step one; step two is still live.
    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useTeamStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'partial step two')).toHaveLength(1)
  })

  it('still drops covered content when live reasoning was not persisted', async () => {
    // Providers routinely summarize, redact, or drop reasoning, so the live
    // thinking block often has no persisted counterpart. A strict positional
    // scan would stop at that mismatch and leave the reply + tools duplicated.
    await seedLoadedSession()

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
        { id: 'live-think', type: 'thinking', content: 'let me think', timestamp: new Date('2026-07-01T00:00:10.500Z') },
        { id: 'live-text', type: 'text', content: 'step one reply', timestamp: new Date('2026-07-01T00:00:11.000Z') },
      ]
      return state
    })

    // Persisted rows carry no reasoning_content — only user + reply.
    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useTeamStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'message A')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
  })

  it('keeps reasoning that is still streaming past the persisted rows', async () => {
    // Trailing live thinking has no persisted counterpart *yet* — dropping it
    // would blank out the reasoning mid-stream and lose the accumulated text.
    await seedLoadedSession()

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'message A', timestamp: new Date('2026-07-01T00:00:10.000Z') },
        { id: 'live-text', type: 'text', content: 'step one reply', timestamp: new Date('2026-07-01T00:00:11.000Z') },
        { id: 'live-think', type: 'thinking', content: 'now for step two', timestamp: new Date('2026-07-01T00:00:12.000Z') },
      ]
      return state
    })

    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'ua', role: 'user', content: 'message A', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'step one reply', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useTeamStore.getState().loadSession('lead-sess')

    expect(rendered().filter((c) => c === 'now for step two')).toHaveLength(1)
    expect(rendered().filter((c) => c === 'step one reply')).toHaveLength(1)
  })

  it('deduplicates a member stream against a running snapshot', async () => {
    // Member turns are anchored by agent-routed (`from_agent`) user rows —
    // members never receive a plain user message, so the lead-only anchor
    // would skip them entirely and leave their tabs duplicated mid-turn.
    await seedLoadedSession()

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
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

    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({ running: true }),
      members: [{
        name: 'worker',
        messages: [
          { id: 'wu', role: 'user', content: 'do the thing', extra: { from_agent: 'lead' }, created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'wa', role: 'assistant', content: 'working on it', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }],
    })))

    await useTeamStore.getState().loadSession('lead-sess')

    expect(rendered('worker').filter((c) => c === 'do the thing')).toHaveLength(1)
    expect(rendered('worker').filter((c) => c === 'working on it')).toHaveLength(1)
  })

  it('does not swallow a re-sent identical message', async () => {
    // The mirror risk of content matching: sending the same text twice must
    // not let the *previous* turn's persisted row cancel the new optimistic
    // bubble. Suffix anchoring covers this — the older row is followed by its
    // own reply, so it cannot align with the head of the live tail.
    await seedLoadedSession()

    useTeamStore.setState((state) => {
      state.isTeamWorking = true
      state.agentStreams.lead.status = 'working'
      state.agentStreams.lead.currentBlocks = [
        { id: 'user-optimistic', type: 'user', content: 'yes', timestamp: new Date('2026-07-01T00:00:20.000Z') },
      ]
      return state
    })

    // History still ends with the *first* "yes" turn; the re-send is not
    // persisted yet.
    mockTeamHistory.mockImplementation(() => Promise.resolve(fullHistory({
      lead: leadSession({
        running: true,
        messages: [
          { id: 'u1', role: 'user', content: 'yes', created_at: '2026-07-01T00:00:10.000Z' },
          { id: 'a1', role: 'assistant', content: 'first answer', created_at: '2026-07-01T00:00:11.000Z' },
        ],
      }),
    })))

    await useTeamStore.getState().loadSession('lead-sess')

    // Both the persisted original and the pending re-send stay visible.
    expect(rendered().filter((c) => c === 'yes')).toHaveLength(2)
  })
})

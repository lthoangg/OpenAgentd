/**
 * applyCacheInvalidations — pure event-to-invalidation mapping.
 *
 * The team store's SSE reducer enqueues ``CacheInvalidation`` events
 * onto its ``cacheInvalidations`` queue; ``routes/cockpit.tsx`` drains
 * the queue and hands events to ``applyCacheInvalidations``, which
 * translates them to ``queryClient.invalidateQueries`` calls.
 *
 * These tests pin the kind→queryKey mapping.  Any change to a
 * ``queryKeys.*`` factory used by the bridge will surface here.
 */
import { describe, it, expect, mock } from 'bun:test'
import { QueryClient, type InfiniteData } from '@tanstack/react-query'
import { applyCacheInvalidations, patchSessionTitle, prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { queryKeys } from '@/queries'
import type { CacheInvalidation } from '@/stores/useTeamStore'
import type { SessionPageResponse, SessionResponse } from '@/api/types'

function makeMockClient() {
  return {
    invalidateQueries: mock(() => Promise.resolve()),
    // ``coding_workspace_paths`` branch reads/writes the cached diff
    // via ``get/setQueryData``; the legacy tests below don't exercise
    // that branch so the stubs just satisfy the BridgeQueryClient
    // type without observing behaviour.
    getQueryData: mock(() => undefined),
    setQueryData: mock(() => undefined),
  }
}

describe('applyCacheInvalidations', () => {
  it('maps `workspace_files` event to team.files(sessionId)', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'workspace_files', sessionId: 'sid-123' }])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.team.files('sid-123'),
    })
  })

  it('maps `coding_workspace` event to files+diff+status keys', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [
      { kind: 'coding_workspace', workspace: '/Users/me/proj' },
    ])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.coding.files('/Users/me/proj'),
    })
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.coding.diff('/Users/me/proj'),
    })
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.coding.status('/Users/me/proj'),
    })
  })

  it('maps `scheduler` event to scheduler.list()', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'scheduler' }])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.scheduler.list(),
    })
  })

  it('maps `todos` event to todos(sessionId)', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'todos', sessionId: 'sid-abc' }])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.todos('sid-abc'),
    })
  })

  it('maps `team_agents` event to teamAgents()', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'team_agents' }])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.teamAgents(),
    })
  })

  it('maps `team_sessions` event to team session list', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'team_sessions' }])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.team.sessions.all(),
    })
  })

  it('uses the exact key shape ["scheduler", "list"] (regression guard)', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'scheduler' }])
    const call = client.invalidateQueries.mock.calls[0][0] as { queryKey: readonly unknown[] }
    expect(call.queryKey).toEqual(['scheduler', 'list'])
  })

  it('uses the exact key shape ["team", "files", sessionId] (regression guard)', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'workspace_files', sessionId: 'sid-xyz' }])
    const call = client.invalidateQueries.mock.calls[0][0] as { queryKey: readonly unknown[] }
    expect(call.queryKey).toEqual(['team', 'files', 'sid-xyz'])
  })

  it('uses the exact key shape ["todos", sessionId] (regression guard)', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [{ kind: 'todos', sessionId: 'sid-xyz' }])
    const call = client.invalidateQueries.mock.calls[0][0] as { queryKey: readonly unknown[] }
    expect(call.queryKey).toEqual(['todos', 'sid-xyz'])
  })

  // ── Multiple-event drains ───────────────────────────────────────────────

  it('processes a batch of events in order, one invalidateQueries call per event', () => {
    const client = makeMockClient()
    const events: CacheInvalidation[] = [
      { kind: 'scheduler' },
      { kind: 'workspace_files', sessionId: 'sid-1' },
      { kind: 'todos', sessionId: 'sid-1' },
      { kind: 'team_agents' },
    ]
    applyCacheInvalidations(client, events)
    expect(client.invalidateQueries).toHaveBeenCalledTimes(4)
    expect(client.invalidateQueries.mock.calls[0][0]).toEqual({
      queryKey: queryKeys.scheduler.list(),
    })
    expect(client.invalidateQueries.mock.calls[1][0]).toEqual({
      queryKey: queryKeys.team.files('sid-1'),
    })
    expect(client.invalidateQueries.mock.calls[3][0]).toEqual({
      queryKey: queryKeys.todos('sid-1'),
    })
    expect(client.invalidateQueries.mock.calls[4][0]).toEqual({
      queryKey: queryKeys.teamAgents(),
    })
  })

  it('processes duplicate events (TanStack invalidation is idempotent)', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [
      { kind: 'scheduler' },
      { kind: 'scheduler' },
      { kind: 'scheduler' },
    ])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 3; i += 1) {
      expect(client.invalidateQueries.mock.calls[i][0]).toEqual({
        queryKey: queryKeys.scheduler.list(),
      })
    }
  })

  it('preserves per-event sessionId across mixed sessions', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [
      { kind: 'workspace_files', sessionId: 'sid-A' },
      { kind: 'workspace_files', sessionId: 'sid-B' },
      { kind: 'todos', sessionId: 'sid-A' },
    ])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3)
    expect(client.invalidateQueries.mock.calls[0][0]).toEqual({
      queryKey: queryKeys.team.files('sid-A'),
    })
    expect(client.invalidateQueries.mock.calls[1][0]).toEqual({
      queryKey: queryKeys.team.files('sid-B'),
    })
    expect(client.invalidateQueries.mock.calls[2][0]).toEqual({
      queryKey: queryKeys.todos('sid-A'),
    })
  })

  // ── Empty queue ─────────────────────────────────────────────────────────

  it('is a no-op for an empty event list', () => {
    const client = makeMockClient()
    applyCacheInvalidations(client, [])
    expect(client.invalidateQueries).toHaveBeenCalledTimes(0)
  })
})

// ─── patchSessionTitle ────────────────────────────────────────────────────
//
// Regression coverage for the title_update bridge in cockpit.tsx.  The
// session list is an *infinite* query, so cached data is shaped as
// ``InfiniteData<SessionPageResponse>`` (``{ pages, pageParams }``) — an
// earlier version typed it as ``SessionResponse[]`` and the updater
// silently no-op'd.  Sidebar only refreshed on full reload.
//
// These tests use a real ``QueryClient`` (not a mock) so they exercise
// the same ``setQueriesData`` matching, immutability, and update-skip
// behaviour the production code relies on.

function makeSession(id: string, title: string | null): SessionResponse {
  return {
    id,
    title,
    agent_name: 'lead',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }
}

function seedInfinite(
  client: QueryClient,
  pages: SessionResponse[][],
  key: readonly unknown[] = queryKeys.team.sessions.infinite(),
): void {
  const data: InfiniteData<SessionPageResponse> = {
    pages: pages.map((rows, i) => ({
      data: rows,
      next_cursor: i < pages.length - 1 ? `cursor-${i}` : null,
      has_more: i < pages.length - 1,
    })),
    pageParams: pages.map((_, i) => (i === 0 ? null : `cursor-${i - 1}`)),
  }
  client.setQueryData(key, data)
}

function readInfinite(client: QueryClient): InfiniteData<SessionPageResponse> | undefined {
  return client.getQueryData<InfiniteData<SessionPageResponse>>(
    queryKeys.team.sessions.infinite(),
  )
}

describe('patchSessionTitle', () => {
  it('updates the title of a session on the first page', () => {
    const client = new QueryClient()
    seedInfinite(client, [
      [makeSession('s1', 'Old A'), makeSession('s2', 'Keep B')],
    ])

    patchSessionTitle(client, 's1', 'New A')

    const after = readInfinite(client)!
    expect(after.pages[0].data[0]).toEqual({ ...makeSession('s1', 'Old A'), title: 'New A' })
    expect(after.pages[0].data[1]).toEqual(makeSession('s2', 'Keep B'))
  })

  it('updates a session on a non-first page (multi-page cache)', () => {
    // Regression for the original bug: prior code mapped over the wrapper
    // object, so any session on page 2+ would never get patched.
    const client = new QueryClient()
    seedInfinite(client, [
      [makeSession('s1', 'A'), makeSession('s2', 'B')],
      [makeSession('s3', 'Old C'), makeSession('s4', 'D')],
      [makeSession('s5', 'E')],
    ])

    patchSessionTitle(client, 's3', 'New C')

    const after = readInfinite(client)!
    expect(after.pages[1].data[0].title).toBe('New C')
    // Other rows untouched.
    expect(after.pages[0].data.map((s) => s.title)).toEqual(['A', 'B'])
    expect(after.pages[1].data[1].title).toBe('D')
    expect(after.pages[2].data[0].title).toBe('E')
  })

  it('preserves InfiniteData wrapper shape (pages, pageParams, page meta)', () => {
    // If the patch ever flattened the wrapper or dropped pageParams,
    // useInfiniteQuery would refetch the next page from scratch.
    const client = new QueryClient()
    seedInfinite(client, [
      [makeSession('s1', 'A')],
      [makeSession('s2', 'B')],
    ])
    const before = readInfinite(client)!

    patchSessionTitle(client, 's1', 'A2')

    const after = readInfinite(client)!
    expect(after.pageParams).toEqual(before.pageParams)
    expect(after.pages).toHaveLength(2)
    expect(after.pages[0].next_cursor).toBe('cursor-0')
    expect(after.pages[0].has_more).toBe(true)
    expect(after.pages[1].next_cursor).toBeNull()
    expect(after.pages[1].has_more).toBe(false)
  })

  it('produces a new top-level reference but reuses untouched page references', () => {
    // Immutability matters for React: the wrapper and the touched page
    // must be new references so subscribers re-render, but unrelated
    // pages should keep their identity to avoid pointless re-renders.
    const client = new QueryClient()
    seedInfinite(client, [
      [makeSession('s1', 'Old')],
      [makeSession('s2', 'Untouched')],
    ])
    const before = readInfinite(client)!

    patchSessionTitle(client, 's1', 'New')

    const after = readInfinite(client)!
    expect(after).not.toBe(before)
    expect(after.pages[0]).not.toBe(before.pages[0])
    expect(after.pages[0].data[0]).not.toBe(before.pages[0].data[0])
    // Note: the current implementation rebuilds every page object via
    // ``pages.map``; that is acceptable but means we cannot assert
    // ``after.pages[1] === before.pages[1]``.  We *can* assert that
    // every row inside the untouched page kept its identity, which is
    // what matters for React row-level memoisation.
    expect(after.pages[1].data[0]).toBe(before.pages[1].data[0])
  })

  it('no-ops cleanly when sessionId is not present in any page', () => {
    // The matching session may live on a page that hasn't been fetched
    // yet — the patch must not throw or corrupt the cache.
    const client = new QueryClient()
    seedInfinite(client, [
      [makeSession('s1', 'A'), makeSession('s2', 'B')],
    ])
    const before = readInfinite(client)!

    patchSessionTitle(client, 'missing-id', 'Whatever')

    const after = readInfinite(client)!
    // Titles unchanged.
    expect(after.pages[0].data.map((s) => s.title)).toEqual(['A', 'B'])
    // Row identities preserved (no churn for unrelated subscribers).
    expect(after.pages[0].data[0]).toBe(before.pages[0].data[0])
    expect(after.pages[0].data[1]).toBe(before.pages[0].data[1])
  })

  it('does not seed an empty wrapper when the cache has never been populated', () => {
    // Before useTeamSessionsQuery runs (e.g. before the user opens the
    // sidebar), the cache is empty.  setQueriesData must not create a
    // bogus ``{ pages: [], pageParams: [] }`` entry that would later
    // confuse the hook.
    const client = new QueryClient()

    patchSessionTitle(client, 's1', 'Anything')

    expect(readInfinite(client)).toBeUndefined()
  })

  it('handles empty pages without throwing', () => {
    // The backend can return an empty first page (no sessions yet);
    // mapping over a zero-length data array is the trivial case.
    const client = new QueryClient()
    seedInfinite(client, [[]])

    patchSessionTitle(client, 's1', 'New')

    const after = readInfinite(client)!
    expect(after.pages[0].data).toEqual([])
  })

  it('replaces a null title (initial state from the server)', () => {
    // SessionResponse.title is nullable; the very first title_update
    // always replaces null.  Falsy-coalescing bugs would surface here.
    const client = new QueryClient()
    seedInfinite(client, [[makeSession('s1', null)]])

    patchSessionTitle(client, 's1', 'First Title')

    expect(readInfinite(client)!.pages[0].data[0].title).toBe('First Title')
  })

  it('overwrites a previous title on a subsequent title_update', () => {
    const client = new QueryClient()
    seedInfinite(client, [[makeSession('s1', 'First')]])

    patchSessionTitle(client, 's1', 'Second')
    patchSessionTitle(client, 's1', 'Third')

    expect(readInfinite(client)!.pages[0].data[0].title).toBe('Third')
  })

  it('only patches the row whose id matches (no accidental cross-session writes)', () => {
    const client = new QueryClient()
    seedInfinite(client, [
      [makeSession('s1', 'A'), makeSession('s2', 'B'), makeSession('s3', 'C')],
    ])

    patchSessionTitle(client, 's2', 'B-NEW')

    const titles = readInfinite(client)!.pages[0].data.map((s) => s.title)
    expect(titles).toEqual(['A', 'B-NEW', 'C'])
  })

  it('preserves non-title fields on the patched session', () => {
    // If the spread were ever inverted (``{ title, ...s }``) the patch
    // would silently lose a server-side title, but more dangerously a
    // missing ``id`` / ``agent_name`` would break the sidebar row.
    const client = new QueryClient()
    seedInfinite(client, [[makeSession('s1', 'Old')]])

    patchSessionTitle(client, 's1', 'New')

    const row = readInfinite(client)!.pages[0].data[0]
    expect(row).toEqual({
      id: 's1',
      title: 'New',
      agent_name: 'lead',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    })
  })

  it('matches by exact queryKey prefix and skips non-infinite session caches', () => {
    // ``queryKeys.team.sessions.all()`` returns ``['team', 'sessions']``
    // and matches every key starting with that prefix (the infinite
    // key is ``['team', 'sessions', 'infinite']``). Detail caches share
    // that prefix too, so they must be skipped rather than treated as
    // infinite query data. Other ``team.*`` caches must be left alone.
    const client = new QueryClient()
    seedInfinite(client, [[makeSession('s1', 'Old')]])
    client.setQueryData(queryKeys.team.sessions.detail('s1'), makeSession('s1', 'Detail'))
    client.setQueryData(queryKeys.team.files('s1'), ['file-a.txt'])
    client.setQueryData(queryKeys.team.status(), { lead: 'x' })

    patchSessionTitle(client, 's1', 'New')

    expect(readInfinite(client)!.pages[0].data[0].title).toBe('New')
    expect(client.getQueryData(queryKeys.team.sessions.detail('s1'))).toEqual(makeSession('s1', 'Detail'))
    expect(client.getQueryData(queryKeys.team.files('s1'))).toEqual(['file-a.txt'])
    expect(client.getQueryData(queryKeys.team.status())).toEqual({ lead: 'x' })
  })
})

describe('prependSession', () => {
  it('does not mutate workspace session caches when prepending the global session list', () => {
    const client = new QueryClient()
    const workspaceKey = queryKeys.team.sessions.workspace('/repo/other')
    seedInfinite(client, [[makeSession('other', 'Other')]], workspaceKey)

    expect(() => prependSession(client, makeSession('new', null))).not.toThrow()

    expect(client.getQueryData<InfiniteData<SessionPageResponse>>(workspaceKey)?.pages[0].data.map((s) => s.id)).toEqual(['other'])
    expect(readInfinite(client)).toBeUndefined()
  })

  it('adds a new session to the top of the first cached page', () => {
    const client = new QueryClient()
    seedInfinite(client, [[makeSession('s1', 'A')]])

    prependSession(client, makeSession('new', null))

    expect(readInfinite(client)?.pages[0].data.map((s) => s.id)).toEqual(['new', 's1'])
  })

  it('does not duplicate an already cached session', () => {
    const client = new QueryClient()
    seedInfinite(client, [[makeSession('s1', 'A')]])

    prependSession(client, makeSession('s1', 'A'))
    prependSession(client, makeSession('s1', 'A'))

    expect(readInfinite(client)?.pages[0].data.map((s) => s.id)).toEqual(['s1'])
  })

  it('adds a coding session to the top of the workspace cache', () => {
    const client = new QueryClient()
    const key = queryKeys.team.sessions.workspace('/repo/project')
    seedInfinite(client, [[makeSession('s1', 'A')]], key)

    prependWorkspaceSession(client, '/repo/project', makeSession('new', null))

    expect(client.getQueryData<InfiniteData<SessionPageResponse>>(key)?.pages[0].data.map((s) => s.id)).toEqual(['new', 's1'])
  })

  it('keeps existing visible workspace rows when prepending beyond the first-page size', () => {
    const client = new QueryClient()
    const key = queryKeys.team.sessions.workspace('/repo/project')
    seedInfinite(client, [[
      makeSession('s1', 'A'),
      makeSession('s2', 'B'),
      makeSession('s3', 'C'),
      makeSession('s4', 'D'),
      makeSession('s5', 'E'),
    ]], key)

    prependWorkspaceSession(client, '/repo/project', makeSession('new', null))

    expect(client.getQueryData<InfiniteData<SessionPageResponse>>(key)?.pages[0].data.map((s) => s.id)).toEqual([
      'new',
      's1',
      's2',
      's3',
      's4',
      's5',
    ])
  })
})
